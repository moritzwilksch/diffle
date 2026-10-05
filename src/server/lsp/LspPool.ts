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
  type Snapshot,
} from '../../shared/protocol.js';
import { fuzzyRank } from '../../shared/fuzzy.js';
import { LspBridge, LspUnavailableError } from './LspBridge.js';
import type { Workspace } from './LspWorkspace.js';
import { resolveServers } from './registry.js';
import { settingsFor } from './configuration.js';

export interface LspPoolOptions {
  /** Where servers run for each snapshot: its root becomes their workspace folder and cwd. */
  workspace: Workspace;
  /** New-side text of a snapshot path, or null when the snapshot does not expose it. */
  read: (path: string) => Promise<string | null>;
  /** Whether the snapshot exposes a path on its new side. */
  has: (path: string) => Promise<boolean>;
  /** The whole pool's status, on every change from any server. */
  onStatus: (status: LspStatus) => void;
  /** Command per language, replacing the built-in candidates. `''` turns the language off. */
  overrides?: Partial<Record<LanguageId, string>>;
  /**
   * Languages to start a server for at construction, whatever the diff holds: the ones named
   * on the command line. They start in `preloadRoot`, the repository, before any snapshot says
   * where the servers belong; a snapshot that needs another root gets its own.
   */
  preload?: LanguageId[];
  preloadRoot?: string;
  /** Test seam, passed to each bridge. */
  spawnProcess?: (command: string, cwd: string) => ChildProcess;
  /** Test seam for the PATH probe. */
  lookup?: (command: string) => string | null;
  /** Untracked documents each server keeps open. */
  maxOpen?: number;
}

/** A resolved command line and the languages routed to it; root-independent. */
interface Server {
  command: string;
  languages: LanguageId[];
}

interface Entry {
  bridge: LspBridge;
  /** Languages routed here; grows when a second language resolves to the same command. */
  languages: LanguageId[];
}

/** The servers running in one root, by command line. */
interface Root {
  dir: string;
  entries: Map<string, Entry>;
  byLanguage: Map<LanguageId, LspBridge>;
}

/** The snapshot fields the pool reads. */
export type TrackedSnapshot = Pick<Snapshot, 'changed' | 'newSha' | 'headSha'>;

/**
 * One language server per language in the diff, started the first time a snapshot
 * names that language and kept for the run. Servers live in the root the workspace
 * assigns the snapshot, one set per root: a snapshot whose new side is the checkout is
 * served from the repository, any other from a detached worktree at its commit, and a
 * root the reader left keeps its servers warm for a return. Routes every request by the
 * path's language to the current root, fans repository-wide queries out to all of its
 * servers, and reports them as one status. Owns no protocol logic: each server is an
 * `LspBridge`.
 */
export class LspPool {
  private servers = new Map<string, Server>();
  private missing: LspMissing[] = [];
  /** Languages already resolved, served or not, so the PATH probe runs once each. */
  private resolved = new Set<LanguageId>();
  private roots = new Map<string, Root>();
  /** The root of the latest snapshot; queries go here. */
  private active: Root | null = null;
  /** The latest `track`'s root switch; queries wait for it so they never ask the previous root. */
  private switching: Promise<void> = Promise.resolve();
  /** Why the latest snapshot has no root: its checkout failed. Cleared by the next that succeeds. */
  private blocker: string | null = null;
  private closing = false;
  private closed?: Promise<void>;

  constructor(private readonly opts: LspPoolOptions) {
    const preload = opts.preload ?? [];
    if (preload.length) {
      this.ensure(preload);
      if (opts.preloadRoot != null && this.servers.size) {
        this.active = this.open(opts.preloadRoot);
        this.publish();
      }
    }
  }

  status(): LspStatus {
    const entries = this.active ? [...this.active.entries.values()] : [];
    return {
      enabled: true,
      servers: entries.map((e) => ({ ...e.bridge.status(), languages: [...e.languages] })),
      missing: this.missing,
      ...(this.blocker ? { blocker: this.blocker } : {}),
    };
  }

  /** Settles once the latest snapshot's servers are in place, so a status read after it is final. */
  idle(): Promise<void> {
    return this.switching;
  }

  /** Reads an external file only if a running server named it. */
  async readExternal(path: string): Promise<Buffer | null> {
    for (const bridge of this.bridges()) {
      const contents = await bridge.readExternal(path);
      if (contents !== null) return contents;
    }
    return null;
  }

  // Every query is async, so a missing server reads as a rejection like any other LSP failure.
  async definition(pos: LspPosition): Promise<LspLocationsResponse> {
    return (await this.bridgeFor(pos.path)).definition(pos);
  }

  async typeDefinition(pos: LspPosition): Promise<LspLocationsResponse> {
    return (await this.bridgeFor(pos.path)).typeDefinition(pos);
  }

  async hover(pos: LspPosition): Promise<LspHoverResponse> {
    return (await this.bridgeFor(pos.path)).hover(pos);
  }

  async tokenKind(pos: LspPosition): Promise<LspTokenKindResponse> {
    return (await this.bridgeFor(pos.path)).tokenKind(pos);
  }

  async references(pos: LspPosition): Promise<LspLocationsResponse> {
    return (await this.bridgeFor(pos.path)).references(pos);
  }

  async occurrences(pos: LspPosition): Promise<LspOccurrencesResponse> {
    return (await this.bridgeFor(pos.path)).occurrences(pos);
  }

  async documentSymbols(path: string): Promise<LspSymbol[]> {
    return (await this.bridgeFor(path)).documentSymbols(path);
  }

  /**
   * Symbols matching `query` from every server of the current root, best `fuzzyRank` match
   * first. One server failing drops its share; only an outage everywhere is an error.
   */
  async workspaceSymbols(query: string, limit = 200): Promise<LspSymbol[]> {
    await this.switching;
    if (this.closing) throw new LspUnavailableError('the language servers are shutting down');
    const bridges = this.active ? [...this.active.entries.values()].map((e) => e.bridge) : [];
    if (!bridges.length) throw new LspUnavailableError(this.why());
    const results = await Promise.allSettled(bridges.map((b) => b.workspaceSymbols(query, limit)));
    const out = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    const failed = results.find((r) => r.status === 'rejected');
    if (!out.length && failed) throw failed.reason;
    return fuzzyRank(out, query, (s) => s.name).slice(0, limit);
  }

  /**
   * Serves `snap`: starts a server for each language the diff has newly grown, in the root
   * the workspace assigns the snapshot, and keeps the diff's files open there. A server whose
   * language left the diff stays up with nothing tracked, so its index is warm if the reader
   * switches back; so does a root the snapshot left. Deleted and binary files have no new
   * side to open.
   */
  track(snap: TrackedSnapshot): Promise<void> {
    // A snapshot can land while the run is ending; a shutting-down server takes no documents.
    if (this.closing) return Promise.resolve();
    const byLanguage = new Map<LanguageId, string[]>();
    for (const f of snap.changed) {
      if (f.status === 'D' || f.binary) continue;
      const language = languageOf(f.path);
      if (!language) continue;
      const list = byLanguage.get(language);
      if (list) list.push(f.path);
      else byLanguage.set(language, [f.path]);
    }
    this.ensure(byLanguage.keys());
    const run = this.switching.then(async () => {
      // No server at all: nothing to place, and no checkout to prepare for it.
      if (this.closing || !this.servers.size) return;
      let dir: string;
      try {
        dir = await this.opts.workspace.rootFor(snap);
      } catch (e) {
        // The status carries the failure; the next snapshot tries again.
        this.blocker = `No checkout for the language servers: ${e instanceof Error ? e.message : String(e)}`;
        this.active = null;
        this.publish();
        return;
      }
      if (this.closing) return;
      const root = this.roots.get(dir) ?? this.open(dir);
      // A language resolved by this snapshot has no server yet in a root opened by an earlier one.
      for (const server of this.servers.values()) if (!root.entries.has(server.command)) this.spawn(root, server);
      const changed = this.active !== root || this.blocker != null;
      this.active = root;
      this.blocker = null;
      if (changed) this.publish();
      const entries = [...root.entries.values()];
      await Promise.all(entries.map((e) => e.bridge.track(e.languages.flatMap((l) => byLanguage.get(l) ?? []))));
    });
    this.switching = run.catch(() => {});
    return run;
  }

  /** Idempotent: the CLI's dispose can run beside a signal handler's. */
  close(): Promise<void> {
    this.closing = true;
    return (this.closed ??= Promise.all([...this.bridges()].map((b) => b.close()))
      .then(() => this.opts.workspace.close())
      .then(() => {}));
  }

  private *bridges(): Iterable<LspBridge> {
    for (const root of this.roots.values()) for (const e of root.entries.values()) yield e.bridge;
  }

  /** The current root's server for `path`, or an unavailable error naming what is missing. */
  private async bridgeFor(path: string): Promise<LspBridge> {
    await this.switching;
    if (this.closing) throw new LspUnavailableError('the language servers are shutting down');
    const language = languageOf(path);
    const bridge = language ? this.active?.byLanguage.get(language) : undefined;
    if (!bridge) throw new LspUnavailableError(this.why(path));
    return bridge;
  }

  private why(path?: string): string {
    return lspBlocker(this.status(), path) ?? 'no language server available';
  }

  /** Resolves servers for languages not seen before and starts them in the current root. Cheap and idempotent per language. */
  private ensure(languages: Iterable<LanguageId>): void {
    if (this.closing) return;
    const fresh = [...new Set(languages)].filter((l) => !this.resolved.has(l));
    if (!fresh.length) return;
    for (const l of fresh) this.resolved.add(l);
    const { servers, missing } = resolveServers(fresh, this.opts.overrides, this.opts.lookup);
    this.missing.push(...missing);
    for (const server of servers) {
      // A command already resolved for one of its languages (clangd for c) takes the next one (cpp).
      const known = this.servers.get(server.command);
      if (known) {
        for (const l of server.languages) if (!known.languages.includes(l)) known.languages.push(l);
      } else {
        this.servers.set(server.command, { command: server.command, languages: [...server.languages] });
      }
      for (const root of this.roots.values()) {
        const entry = root.entries.get(server.command);
        if (entry) this.route(root, entry, server.languages);
      }
    }
    if (servers.length || missing.length) this.publish();
  }

  private open(dir: string): Root {
    const root: Root = { dir, entries: new Map(), byLanguage: new Map() };
    this.roots.set(dir, root);
    for (const server of this.servers.values()) this.spawn(root, server);
    return root;
  }

  private spawn(root: Root, server: Server): void {
    const entry: Entry = {
      bridge: LspBridge.start({
        command: server.command,
        settings: settingsFor(server.languages, server.command),
        root: root.dir,
        read: this.opts.read,
        has: this.opts.has,
        onStatus: () => {
          if (this.active === root) this.publish();
        },
        spawnProcess: this.opts.spawnProcess,
        maxOpen: this.opts.maxOpen,
      }),
      languages: [],
    };
    root.entries.set(server.command, entry);
    this.route(root, entry, server.languages);
  }

  private route(root: Root, entry: Entry, languages: LanguageId[]): void {
    for (const l of languages) {
      if (!entry.languages.includes(l)) entry.languages.push(l);
      root.byLanguage.set(l, entry.bridge);
    }
  }

  private publish(): void {
    if (!this.closing) this.opts.onStatus(this.status());
  }
}
