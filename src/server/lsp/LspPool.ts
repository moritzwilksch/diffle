import type { ChildProcess } from 'node:child_process';
import {
  followsCheckout,
  languageOf,
  type ChangedFile,
  type LanguageId,
  type LspHoverResponse,
  type LspLocationsResponse,
  type LspLogEntry,
  type LspMissing,
  type LspOccurrencesResponse,
  type LspPosition,
  type LspStatus,
  type LspSymbolsResponse,
  type Snapshot,
} from '../../shared/protocol.js';
import { fuzzyRank } from '../../shared/fuzzy.js';
import { LspBridge } from './LspBridge.js';
import { type Answer, mergeHovers, mergeLocations, union } from './merge.js';
import { LspUnavailableError } from './LspProcess.js';
import { definitionOf, resolveServers, type ResolvedServer } from './registry.js';
import { findOnPath } from './which.js';

export interface LspPoolOptions {
  /** Repository root; becomes every server's workspace folder and cwd. */
  root: string;
  /** New-side text of a snapshot path, or null when the snapshot does not expose it. */
  read: (path: string) => Promise<string | null>;
  /** Whether the snapshot exposes a path on its new side. */
  has: (path: string) => Promise<boolean>;
  /** The whole pool's status, coalesced: at most one call per PUBLISH_MS while servers chatter. */
  onStatus: (status: LspStatus) => void;
  /** Command per language, replacing the built-in candidates. `''` turns the language off. */
  overrides?: Partial<Record<LanguageId, string>>;
  /** Languages to start a server for at construction, whatever the diff holds: the ones named on the command line. */
  preload?: LanguageId[];
  /** Test seam, passed to each bridge. */
  spawnProcess?: (command: string, cwd: string) => ChildProcess;
  /** Test seam for the PATH probe. */
  lookup?: (command: string) => string | null;
  /** Untracked documents each server keeps open. */
  maxOpen?: number;
}

/** What `track` reads of a snapshot. */
export type TrackedSnapshot = Pick<Snapshot, 'newSha' | 'headSha'> & {
  changed: Pick<ChangedFile, 'path' | 'status' | 'binary'>[];
};

/** A running server and its languages, both lists growing as later snapshots resolve to the same command. */
interface Entry extends ResolvedServer {
  bridge: LspBridge;
}

/**
 * A status change goes out at once when the pool has been quiet, and later ones within
 * this window ride on one trailing publish: a server logging a hundred stderr lines
 * while indexing is a few broadcasts, not a hundred.
 */
const PUBLISH_MS = 20;

/**
 * The language servers of one run, started the first time a snapshot names a language
 * they serve and kept for the run. Routes like an editor: every server for a file's
 * language is asked at once and their hovers, definitions and references are merged,
 * owner first; highlights and outlines come from the owner alone, as two
 * servers' highlight sets would only clash. Repository-wide queries fan out to all
 * servers, and all of them report as one status. Owns no protocol logic: each server
 * is an `LspBridge`.
 */
export class LspPool {
  /** Servers by command line: languages that resolve to the same command share one process. */
  private entries = new Map<string, Entry>();
  private missing: LspMissing[] = [];
  /** Languages already resolved, served or not, so the PATH probe runs once each. */
  private resolved = new Set<LanguageId>();
  private closing = false;
  private closed?: Promise<void>;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private publishDue = false;

  constructor(private readonly opts: LspPoolOptions) {
    this.ensure(opts.preload ?? []);
  }

  status(): LspStatus {
    return {
      enabled: true,
      servers: [...this.entries.values()].map((e) => ({
        ...e.bridge.status(),
        languages: [...e.languages],
        joins: [...e.joins],
        supports: e.bridge.features(),
      })),
      missing: this.missing,
    };
  }

  /** The retained log lines of the server started by `command`, or null when none was. */
  log(command: string): LspLogEntry[] | null {
    return this.entries.get(command)?.bridge.entries() ?? null;
  }

  /** Reads an external file only if a running server named it. */
  async readExternal(path: string): Promise<Buffer | null> {
    for (const { bridge } of this.entries.values()) {
      const contents = await bridge.readExternal(path);
      if (contents !== null) return contents;
    }
    return null;
  }

  // Every query is async, so a missing server reads as a rejection like any other LSP failure.
  definition(pos: LspPosition): Promise<LspLocationsResponse> {
    return this.locations(pos, (b) => b.definition(pos));
  }

  typeDefinition(pos: LspPosition): Promise<LspLocationsResponse> {
    return this.locations(pos, (b) => b.typeDefinition(pos));
  }

  references(pos: LspPosition): Promise<LspLocationsResponse> {
    return this.locations(pos, (b) => b.references(pos));
  }

  hover(pos: LspPosition): Promise<LspHoverResponse> {
    return this.fanOut(
      pos.path,
      (b) => b.hover(pos),
      mergeHovers,
      (r) => r.contents == null,
    );
  }

  async occurrences(pos: LspPosition): Promise<LspOccurrencesResponse> {
    return this.ownerFor(pos.path).occurrences(pos);
  }

  async documentSymbols(path: string): Promise<LspSymbolsResponse> {
    return this.ownerFor(path).documentSymbols(path);
  }

  /**
   * Symbols matching `query` from every running server, best `fuzzyRank` match first.
   * Ranked before the cap: servers list loose matches in their own order.
   */
  async workspaceSymbols(query: string, limit = 200): Promise<LspSymbolsResponse> {
    if (this.closing) throw new LspUnavailableError('the language servers are shutting down');
    const bridges = [...this.entries.values()].map((e) => e.bridge);
    if (!bridges.length) throw new LspUnavailableError('no language server is running');
    return union(
      bridges.map((b) => b.workspaceSymbols(query)),
      (answers) => ({
        symbols: fuzzyRank(
          answers.flatMap((a) => a.symbols),
          query,
          (s) => s.name,
        ).slice(0, limit),
      }),
      (r) => !r.symbols.length,
    );
  }

  /**
   * Keeps the diff's files open in every server for their language, starting one for each
   * language the diff has newly grown. A server whose language left the diff stays up
   * with nothing tracked, so its index is warm if the reader switches back. Nothing is
   * tracked when the new side is not the checkout: a server would see text that
   * contradicts the disk it indexes, and `lspBlocker` refuses queries there anyway.
   */
  track(snap: TrackedSnapshot): Promise<void> {
    // A snapshot can land while the run is ending; a shutting-down server takes no documents.
    if (this.closing) return Promise.resolve();
    const paths = followsCheckout(snap)
      ? snap.changed.filter((f) => f.status !== 'D' && !f.binary).map((f) => f.path)
      : [];
    const byLanguage = new Map<LanguageId, string[]>();
    for (const path of paths) {
      const language = languageOf(path);
      if (!language) continue;
      const list = byLanguage.get(language);
      if (list) list.push(path);
      else byLanguage.set(language, [path]);
    }
    this.ensure(byLanguage.keys());
    const entries = [...this.entries.values()];
    return Promise.all(
      entries.map((e) => e.bridge.track([...e.languages, ...e.joins].flatMap((l) => byLanguage.get(l) ?? []))),
    ).then(() => {});
  }

  /** Idempotent: the CLI's dispose can run beside a signal handler's. */
  close(): Promise<void> {
    this.closing = true;
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.publishTimer = null;
    return (this.closed ??= Promise.all([...this.entries.values()].map((e) => e.bridge.close())).then(() => {}));
  }

  /**
   * Every server for `path`, owner first. A language nothing owns is still served by the
   * servers joining it. The route has already asked `lspBlocker` why none would answer,
   * so an empty list here is a race with a snapshot or a shutdown, not a message to word.
   */
  private bridgesFor(path: string): LspBridge[] {
    if (this.closing) throw new LspUnavailableError('the language servers are shutting down');
    const language = languageOf(path);
    const entries = [...this.entries.values()];
    const bridges = language
      ? [
          ...entries.filter((e) => e.languages.includes(language)),
          ...entries.filter((e) => e.joins.includes(language)),
        ].map((e) => e.bridge)
      : [];
    if (!bridges.length) throw new LspUnavailableError(`no language server for ${path}`);
    return bridges;
  }

  private ownerFor(path: string): LspBridge {
    return this.bridgesFor(path)[0]!;
  }

  /** Every server's locations for `pos`, owner first, each place once. */
  private locations(pos: LspPosition, ask: (bridge: LspBridge) => Promise<LspLocationsResponse>) {
    return this.fanOut(pos.path, ask, mergeLocations, (r) => !r.locations.length);
  }

  /** Asks every server for `path` at once and merges what they answered (see `union`). */
  private async fanOut<T extends Answer>(
    path: string,
    ask: (bridge: LspBridge) => Promise<T>,
    merge: (answers: T[]) => T,
    empty: (merged: T) => boolean,
  ): Promise<T> {
    return union(this.bridgesFor(path).map(ask), merge, empty);
  }

  /** Resolves and starts servers for languages not seen before. Cheap and idempotent per language. */
  private ensure(languages: Iterable<LanguageId>): void {
    if (this.closing) return;
    const fresh = [...new Set(languages)].filter((l) => !this.resolved.has(l));
    if (!fresh.length) return;
    for (const l of fresh) this.resolved.add(l);
    const { servers, missing } = resolveServers(fresh, this.opts.overrides, this.opts.lookup);
    this.missing.push(...missing);
    for (const server of servers) {
      // A process already up for one of its languages (clangd for c) takes the next one (cpp).
      const entry = this.entries.get(server.command) ?? this.spawn(server.command);
      for (const l of server.languages) if (!entry.languages.includes(l)) entry.languages.push(l);
      for (const l of server.joins) if (!entry.joins.includes(l)) entry.joins.push(l);
    }
    if (servers.length || missing.length) this.publish();
  }

  private spawn(command: string): Entry {
    const definition = definitionOf(command);
    const ctx = { root: this.opts.root, lookup: this.opts.lookup ?? findOnPath };
    const bridge = new LspBridge({
      command,
      settings: definition.settings ? Promise.resolve(definition.settings(ctx)) : undefined,
      initializationOptions: definition.initializationOptions?.(ctx),
      root: this.opts.root,
      read: this.opts.read,
      has: this.opts.has,
      onStatus: () => this.publish(),
      spawnProcess: this.opts.spawnProcess,
      maxOpen: this.opts.maxOpen,
    });
    const entry: Entry = { command, bridge, languages: [], joins: [] };
    this.entries.set(command, entry);
    return entry;
  }

  private publish(): void {
    if (this.closing) return;
    if (this.publishTimer) {
      this.publishDue = true;
      return;
    }
    this.opts.onStatus(this.status());
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      if (!this.publishDue || this.closing) return;
      this.publishDue = false;
      this.publish();
    }, PUBLISH_MS);
    this.publishTimer.unref();
  }
}
