import type { ChildProcess } from 'node:child_process';
import {
  languageOf,
  lspBlocker,
  type LanguageId,
  type LspHoverResponse,
  type LspLocationsResponse,
  type LspMissing,
  type LspOccurrencesResponse,
  type LspPosition,
  type LspStatus,
  type LspSymbol,
  type LspTokenKindResponse,
} from '../../shared/protocol.js';
import { fuzzyRank } from '../../shared/fuzzy.js';
import { LspBridge, LspUnavailableError } from './LspBridge.js';
import { resolveServers } from './registry.js';
import { initializationOptionsFor, settingsFor } from './configuration.js';

export interface LspPoolOptions {
  /** Repository root; becomes every server's workspace folder and cwd. */
  root: string;
  /** New-side text of a snapshot path, or null when the snapshot does not expose it. */
  read: (path: string) => Promise<string | null>;
  /** Whether the snapshot exposes a path on its new side. */
  has: (path: string) => Promise<boolean>;
  /** The whole pool's status, on every change from any server. */
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

interface Entry {
  bridge: LspBridge;
  /** Languages this server owns; grows when a second language resolves to the same command. */
  languages: LanguageId[];
  /** Languages it answers for beside their owner (Tailwind's class hovers in markup). */
  joins: LanguageId[];
}

/**
 * The language servers of one run, started the first time a snapshot names a language
 * they serve and kept for the run. Routes like an editor: every server for a file's
 * language is asked at once and their hovers, definitions and references are merged,
 * owner first; highlights, token kinds and outlines come from the owner alone, as two
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
      })),
      missing: this.missing,
    };
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
    return this.fanOut(
      pos.path,
      (b) => b.definition(pos),
      mergeLocations,
      (r) => !r.locations.length,
    );
  }

  typeDefinition(pos: LspPosition): Promise<LspLocationsResponse> {
    return this.fanOut(
      pos.path,
      (b) => b.typeDefinition(pos),
      mergeLocations,
      (r) => !r.locations.length,
    );
  }

  hover(pos: LspPosition): Promise<LspHoverResponse> {
    return this.fanOut(
      pos.path,
      (b) => b.hover(pos),
      mergeHovers,
      (r) => r.contents == null,
    );
  }

  references(pos: LspPosition): Promise<LspLocationsResponse> {
    return this.fanOut(
      pos.path,
      (b) => b.references(pos),
      mergeLocations,
      (r) => !r.locations.length,
    );
  }

  async tokenKind(pos: LspPosition): Promise<LspTokenKindResponse> {
    return this.ownerFor(pos.path).tokenKind(pos);
  }

  async occurrences(pos: LspPosition): Promise<LspOccurrencesResponse> {
    return this.ownerFor(pos.path).occurrences(pos);
  }

  async documentSymbols(path: string): Promise<LspSymbol[]> {
    return this.ownerFor(path).documentSymbols(path);
  }

  /**
   * Symbols matching `query` from every running server, best `fuzzyRank` match first. One server
   * failing drops its share; only an outage everywhere is an error.
   */
  async workspaceSymbols(query: string, limit = 200): Promise<LspSymbol[]> {
    const bridges = [...this.entries.values()].map((e) => e.bridge);
    if (!bridges.length) throw new LspUnavailableError(this.why());
    const results = await Promise.allSettled(bridges.map((b) => b.workspaceSymbols(query, limit)));
    const out = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    const failed = results.find((r) => r.status === 'rejected');
    if (!out.length && failed) throw failed.reason;
    return fuzzyRank(out, query, (s) => s.name).slice(0, limit);
  }

  /**
   * Keeps the diff's files open in every server for their language, starting one for each
   * language the diff has newly grown. A server whose language left the diff stays up
   * with nothing tracked, so its index is warm if the reader switches back.
   */
  track(paths: string[]): Promise<void> {
    // A snapshot can land while the run is ending; a shutting-down server takes no documents.
    if (this.closing) return Promise.resolve();
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
    return (this.closed ??= Promise.all([...this.entries.values()].map((e) => e.bridge.close())).then(() => {}));
  }

  /**
   * Every server for `path`, owner first, or an unavailable error naming what is missing.
   * A language nothing owns is still served by the servers joining it.
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
    if (!bridges.length) throw new LspUnavailableError(this.why(path));
    return bridges;
  }

  private ownerFor(path: string): LspBridge {
    return this.bridgesFor(path)[0]!;
  }

  /**
   * Asks every server for `path` at once and merges what they answered. A server that
   * fails drops its share; its error surfaces only when the merged answer is `empty`, so
   * an owner still starting is reported as such rather than as silence.
   */
  private async fanOut<T>(
    path: string,
    ask: (bridge: LspBridge) => Promise<T>,
    merge: (answers: T[]) => T,
    empty: (merged: T) => boolean,
  ): Promise<T> {
    const results = await Promise.allSettled(this.bridgesFor(path).map(ask));
    const merged = merge(results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : [])));
    const failed = results.find((r) => r.status === 'rejected');
    if (failed && empty(merged)) throw failed.reason;
    return merged;
  }

  private why(path?: string): string {
    return lspBlocker(this.status(), path) ?? 'no language server available';
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
      const entry = this.entries.get(server.command) ?? this.spawn(server.command, server.languages);
      for (const l of server.languages) if (!entry.languages.includes(l)) entry.languages.push(l);
      for (const l of server.joins) if (!entry.joins.includes(l)) entry.joins.push(l);
    }
    if (servers.length || missing.length) this.publish();
  }

  private spawn(command: string, languages: LanguageId[]): Entry {
    const entry: Entry = {
      bridge: LspBridge.start({
        command,
        settings: settingsFor(languages, command, this.opts.lookup),
        initializationOptions: initializationOptionsFor(command, this.opts.root, this.opts.lookup),
        root: this.opts.root,
        read: this.opts.read,
        has: this.opts.has,
        onStatus: () => this.publish(),
        spawnProcess: this.opts.spawnProcess,
        maxOpen: this.opts.maxOpen,
      }),
      languages: [],
      joins: [],
    };
    this.entries.set(command, entry);
    return entry;
  }

  private publish(): void {
    if (!this.closing) this.opts.onStatus(this.status());
  }
}

/** Every server's hover, owner first, as one tooltip; the span is the first one offered. */
function mergeHovers(answers: LspHoverResponse[]): LspHoverResponse {
  const said = answers.filter((a) => a.contents != null);
  if (!said.length) return { contents: null };
  const range = said.find((a) => a.range)?.range;
  return { contents: said.map((a) => a.contents).join('\n\n---\n\n'), ...(range ? { range } : {}) };
}

/** The union of every server's locations, owner first, each place once. */
function mergeLocations(answers: LspLocationsResponse[]): LspLocationsResponse {
  const seen = new Set<string>();
  const locations = answers.flatMap((a) =>
    a.locations.filter((l) => {
      const key = `${l.path}\0${l.line}\0${l.col}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  );
  return { locations };
}
