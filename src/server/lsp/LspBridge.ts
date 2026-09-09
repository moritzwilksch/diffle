import { spawn, type ChildProcess } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  isPython,
  type LspHoverResponse,
  type LspLocation,
  type LspLocationsResponse,
  type LspPosition,
  type LspStatus,
  type LspSymbol,
  type LspTokenKindResponse,
} from '../../shared/protocol.js';
import { mapLimit } from '../concurrency.js';
import { fileLinkUris, hoverMarkdown, localizeFileLinks, type HoverContents } from './hover.js';
import { JsonRpcConnection } from './JsonRpc.js';

export interface LspBridgeOptions {
  /** Shell command line that starts a stdio language server, e.g. `pyrefly lsp`. */
  command: string;
  /** Repository root; becomes the workspace folder and the process cwd. */
  root: string;
  /** New-side text of a snapshot path, or null when the snapshot does not expose it. */
  read: (path: string) => Promise<string | null>;
  /** Whether the snapshot exposes a path on its new side. Membership only: no content is read. */
  has: (path: string) => Promise<boolean>;
  onStatus: (status: LspStatus) => void;
  /** Test seam: replaces `spawn(command, { shell: true })`. */
  spawnProcess?: (command: string, cwd: string) => ChildProcess;
  /** Most documents kept open beyond the tracked set; the least recently used is closed first. Default MAX_UNTRACKED_OPEN. */
  maxOpen?: number;
}

/** The server is off, still starting, or gone. Routes answer 409. */
export class LspUnavailableError extends Error {}

// LSP wire shapes, only the fields read here.
interface Position {
  line: number;
  character: number;
}
interface Range {
  start: Position;
  end: Position;
}
interface Location {
  uri: string;
  range: Range;
}
interface LocationLink {
  targetUri: string;
  targetRange: Range;
  targetSelectionRange: Range;
}
interface DocumentSymbol {
  name: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}
interface SymbolInformation {
  name: string;
  kind: number;
  containerName?: string;
  location: Location | { uri: string };
}

/**
 * Token types by index when the server publishes no legend. The LSP spec's own
 * enumeration; pyrefly answers semantic token requests without advertising the
 * provider and numbers its tokens this way.
 */
const DEFAULT_TOKEN_TYPES = [
  'namespace',
  'type',
  'class',
  'enum',
  'interface',
  'struct',
  'typeParameter',
  'parameter',
  'variable',
  'property',
  'enumMember',
  'event',
  'function',
  'method',
  'macro',
  'keyword',
  'modifier',
  'comment',
  'string',
  'number',
  'regexp',
  'operator',
  'decorator',
];

const STDERR_TAIL = 2000;
/**
 * pyrefly reports nothing about its workspace index over the protocol (no
 * `$/progress`, even when asked) but logs it on stderr at the default level.
 * Other servers never match and simply never report indexing.
 */
const INDEX_START = /Populating up to \d+ files in the workspace/;
const INDEX_DONE = /Populated all files in the workspace/;
const INIT_TIMEOUT_MS = 60_000;
/**
 * Navigation opens whatever file a query lands in. Without a cap every path
 * visited in a long review stays open in the server, growing its memory and
 * per-save recheck cost.
 */
const MAX_UNTRACKED_OPEN = 64;
/** Concurrent snapshot reads while mapping a result set back to paths. */
const READ_CONCURRENCY = 8;
/** Graceful shutdown budget. Both together stay under the CLI's hard exit deadline (main.ts). */
const SHUTDOWN_RPC_MS = 500;
const SIGKILL_AFTER_MS = 500;

/**
 * Owns one language server process: the only module that spawns one. Speaks
 * JSON-RPC to it, keeps the queried document in sync from `read` before each
 * request, and maps results back to snapshot paths. Never throws from `start`;
 * failures become a status the UI can show.
 */
export class LspBridge {
  private child: ChildProcess | null = null;
  private rpc: JsonRpcConnection | null = null;
  private current: LspStatus;
  private ready: Promise<void>;
  private stderr = '';
  /** Partial last stderr line, so a log phrase split across chunks still matches. */
  private stderrTail = '';
  /** Open documents, least recently synced first. */
  private open = new Map<string, { version: number; text: string }>();
  /** Syncs in flight by path, so a track pass and a query racing on one file send a single didOpen. */
  private syncing = new Map<string, Promise<void>>();
  /** Paths `track` opened on the snapshot's behalf; closed again when they leave the snapshot. */
  private tracked = new Set<string>();
  private tracking: Promise<void> = Promise.resolve();
  private closing = false;
  private ownsGroup = false;
  /** Symlink-free root; servers often canonicalize, so URIs may not share the root's spelling. */
  private readonly realRoot: string;
  /** Semantic token legend from the server's capabilities, else the spec's default numbering. */
  private tokenTypes: string[] = DEFAULT_TOKEN_TYPES;

  private constructor(private readonly opts: LspBridgeOptions) {
    this.realRoot = safeRealpathSync(opts.root);
    this.current = { state: 'starting', command: opts.command };
    this.ready = this.launch();
    this.ready.catch(() => {});
  }

  static start(opts: LspBridgeOptions): LspBridge {
    return new LspBridge(opts);
  }

  status(): LspStatus {
    return this.current;
  }

  async definition(pos: LspPosition): Promise<LspLocationsResponse> {
    const rpc = await this.sync(pos.path);
    const result = await rpc.request<null | Location | Location[] | LocationLink[]>('textDocument/definition', {
      textDocument: { uri: this.uri(pos.path) },
      position: toLsp(pos),
    });
    return this.toLocations(normalizeLocations(result));
  }

  async typeDefinition(pos: LspPosition): Promise<LspLocationsResponse> {
    const rpc = await this.sync(pos.path);
    const result = await rpc.request<null | Location | Location[] | LocationLink[]>('textDocument/typeDefinition', {
      textDocument: { uri: this.uri(pos.path) },
      position: toLsp(pos),
    });
    return this.toLocations(normalizeLocations(result));
  }

  async hover(pos: LspPosition): Promise<LspHoverResponse> {
    const rpc = await this.sync(pos.path);
    const result = await rpc.request<null | { contents: HoverContents; range?: Range }>('textDocument/hover', {
      textDocument: { uri: this.uri(pos.path) },
      position: toLsp(pos),
    });
    const md = result ? hoverMarkdown(result.contents) : null;
    const res: LspHoverResponse = { contents: md == null ? null : localizeFileLinks(md, await this.resolveLinks(md)) };
    if (result?.range) {
      const { start, end } = result.range;
      res.range = { line: start.line + 1, col: start.character, endLine: end.line + 1, endCol: end.character };
    }
    return res;
  }

  /**
   * The semantic token class at a position, via `textDocument/semanticTokens/range`
   * on that one line. A server without semantic tokens, or a position between
   * tokens, yields null, so callers treat null as "no opinion".
   */
  async tokenKind(pos: LspPosition): Promise<LspTokenKindResponse> {
    const rpc = await this.sync(pos.path);
    const line = Math.max(0, pos.line - 1);
    let data: number[];
    try {
      const result = await rpc.request<null | { data: number[] }>('textDocument/semanticTokens/range', {
        textDocument: { uri: this.uri(pos.path) },
        range: { start: { line, character: 0 }, end: { line: line + 1, character: 0 } },
      });
      data = result?.data ?? [];
    } catch (e) {
      if (e instanceof LspUnavailableError) throw e;
      // Method not supported: a plain server error, not an outage.
      return { kind: null };
    }
    // Tokens come as 5-tuples relative to the previous token: deltaLine, deltaStart, length, type, modifiers.
    let tokLine = 0;
    let tokStart = 0;
    for (let i = 0; i + 4 < data.length; i += 5) {
      const deltaLine = data[i]!;
      tokLine += deltaLine;
      tokStart = deltaLine === 0 ? tokStart + data[i + 1]! : data[i + 1]!;
      if (tokLine !== line || pos.col < tokStart || pos.col >= tokStart + data[i + 2]!) continue;
      return { kind: this.tokenTypes[data[i + 3]!] ?? null };
    }
    return { kind: null };
  }

  async references(pos: LspPosition, opts: { includeDeclaration?: boolean } = {}): Promise<LspLocationsResponse> {
    const rpc = await this.sync(pos.path);
    const result = await rpc.request<Location[] | null>('textDocument/references', {
      textDocument: { uri: this.uri(pos.path) },
      position: toLsp(pos),
      context: { includeDeclaration: opts.includeDeclaration ?? true },
    });
    return this.toLocations(normalizeLocations(result));
  }

  /**
   * Keeps the diff's own files open in the server with their snapshot text.
   * Servers index the workspace lazily and cap how much of it they index
   * (pyrefly: in the background from the first open, 2000 files), so a
   * reference in a changed file that nobody queried yet is otherwise only found
   * once its file happens to be indexed, and from the text on disk. Opening
   * everything at start also warms the index before the first query. Calls are
   * serialized; the last set wins. Never throws: a path the snapshot cannot read
   * is skipped.
   */
  track(paths: string[]): Promise<void> {
    const run = this.tracking.then(() => this.trackNow(paths)).catch(() => {});
    this.tracking = run;
    return run;
  }

  private async trackNow(paths: string[]): Promise<void> {
    const rpc = await this.ensureReady();
    const next = new Set(paths);
    for (const path of this.tracked) {
      if (next.has(path)) continue;
      this.tracked.delete(path);
      if (this.open.delete(path)) rpc.notify('textDocument/didClose', { textDocument: { uri: this.uri(path) } });
    }
    for (const path of next) {
      try {
        await this.sync(path);
        this.tracked.add(path);
      } catch (e) {
        if (e instanceof LspUnavailableError) return;
        /* not readable on the new side (deleted, binary, gone between snapshot and read): nothing to open */
      }
    }
  }

  async documentSymbols(path: string): Promise<LspSymbol[]> {
    const rpc = await this.sync(path);
    const result = await rpc.request<DocumentSymbol[] | SymbolInformation[] | null>('textDocument/documentSymbol', {
      textDocument: { uri: this.uri(path) },
    });
    if (!result) return [];
    const out: LspSymbol[] = [];
    if (isDocumentSymbols(result)) {
      const walk = (syms: DocumentSymbol[], container?: string) => {
        for (const s of syms) {
          const start = (s.selectionRange ?? s.range).start;
          const endLine = Math.max(start.line, (s.range ?? s.selectionRange).end.line) + 1;
          out.push({
            name: s.name,
            kind: s.kind,
            container,
            path,
            line: start.line + 1,
            endLine,
            col: start.character,
          });
          if (s.children?.length) walk(s.children, s.name);
        }
      };
      walk(result);
      return out;
    }
    for (const s of result) {
      const start = 'range' in s.location ? s.location.range.start : { line: 0, character: 0 };
      const end = 'range' in s.location ? s.location.range.end : start;
      out.push({
        name: s.name,
        kind: s.kind,
        container: s.containerName || undefined,
        path,
        line: start.line + 1,
        endLine: Math.max(start.line, end.line) + 1,
        col: start.character,
      });
    }
    return out;
  }

  /**
   * Symbols the server knows for `query`, limited to paths the snapshot
   * exposes. Membership comes from `has`, never from reading the file: a
   * per-keystroke search must not read every hit's text.
   */
  async workspaceSymbols(query: string, limit = 200): Promise<LspSymbol[]> {
    const rpc = await this.ensureReady();
    const result = await rpc.request<SymbolInformation[] | null>('workspace/symbol', { query });
    if (!result) return [];
    const paths = await Promise.all(result.map((s) => this.pathOf(s.location.uri)));
    const inside = await this.membership(paths);
    const out: LspSymbol[] = [];
    const seen = new Set<string>();
    result.forEach((s, i) => {
      const path = paths[i];
      if (path == null || !inside.get(path) || out.length >= limit) return;
      // pyrefly reports one entry per import site; one per definition is enough here.
      const start = 'range' in s.location ? s.location.range.start : { line: 0, character: 0 };
      const key = `${path}:${start.line}:${start.character}:${s.name}`;
      if (seen.has(key)) return;
      seen.add(key);
      const end = 'range' in s.location ? s.location.range.end : start;
      out.push({
        name: s.name,
        kind: s.kind,
        container: s.containerName || undefined,
        path,
        line: start.line + 1,
        endLine: Math.max(start.line, end.line) + 1,
        col: start.character,
      });
    });
    return out;
  }

  /** `has` for each distinct path, in parallel. */
  private async membership(paths: (string | null)[]): Promise<Map<string, boolean>> {
    const distinct = [...new Set(paths.filter((p): p is string => p != null))];
    const flags = await mapLimit(distinct, READ_CONCURRENCY, (p) => this.opts.has(p));
    return new Map(distinct.map((p, i) => [p, flags[i]!]));
  }

  async close(): Promise<void> {
    this.closing = true;
    const rpc = this.rpc;
    const child = this.child;
    if (rpc && child && child.exitCode == null) {
      try {
        await rpc.request('shutdown', null, SHUTDOWN_RPC_MS);
        rpc.notify('exit', null);
      } catch {
        /* the process is killed below regardless */
      }
    }
    if (child && child.exitCode == null) {
      const exited = new Promise<void>((res) => child.once('exit', () => res()));
      const timer = setTimeout(() => this.kill(child, 'SIGKILL'), SIGKILL_AFTER_MS);
      timer.unref();
      this.kill(child, 'SIGTERM');
      await exited;
      clearTimeout(timer);
    }
  }

  /**
   * Signals the child's process group when we made it a group leader, else the
   * child alone. On Windows `shell: true` means the child is cmd.exe, so the tree
   * below it is killed explicitly.
   */
  private kill(child: ChildProcess, signal: NodeJS.Signals): void {
    if (child.pid != null && process.platform === 'win32' && !this.opts.spawnProcess) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => child.kill());
      return;
    }
    if (this.ownsGroup && child.pid != null) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        /* group already gone; fall through to the child itself */
      }
    }
    child.kill(signal);
  }

  private async launch(): Promise<void> {
    let child: ChildProcess;
    try {
      child = this.opts.spawnProcess
        ? this.opts.spawnProcess(this.opts.command, this.opts.root)
        : spawn(this.opts.command, {
            cwd: this.opts.root,
            shell: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: DETACH,
          });
      this.ownsGroup = !this.opts.spawnProcess && DETACH;
    } catch (e) {
      this.fail(`cannot start "${this.opts.command}": ${(e as Error).message}`);
      throw e;
    }
    this.child = child;
    child.stderr?.on('data', (d: Buffer) => {
      const chunk = d.toString('utf8');
      this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL);
      this.noteIndexing(chunk);
    });
    child.on('error', (e) => this.fail(`cannot start "${this.opts.command}": ${e.message}`));
    child.on('exit', (code, signal) => {
      if (this.closing) return;
      this.fail(
        `"${this.opts.command}" exited (${signal ?? code})${this.stderr.trim() ? `: ${lastLine(this.stderr)}` : ''}`,
      );
    });
    if (!child.stdin || !child.stdout) {
      this.fail(`cannot start "${this.opts.command}": no stdio`);
      throw new Error('no stdio');
    }
    const rpc = new JsonRpcConnection(child.stdout, child.stdin);
    this.rpc = rpc;
    const rootUri = pathToFileURL(this.opts.root).href;
    try {
      const init = await rpc.request<{
        capabilities?: { semanticTokensProvider?: { legend?: { tokenTypes?: string[] } } };
      }>(
        'initialize',
        {
          processId: process.pid,
          clientInfo: { name: 'diffle' },
          rootUri,
          rootPath: this.opts.root,
          workspaceFolders: [{ uri: rootUri, name: 'workspace' }],
          capabilities: {
            textDocument: {
              synchronization: { didSave: false },
              definition: { linkSupport: true },
              typeDefinition: { linkSupport: true },
              references: {},
              hover: { contentFormat: ['markdown', 'plaintext'] },
              documentSymbol: { hierarchicalDocumentSymbolSupport: true },
              semanticTokens: {
                requests: { range: true },
                tokenTypes: DEFAULT_TOKEN_TYPES,
                tokenModifiers: [],
                formats: ['relative'],
              },
            },
            workspace: { symbol: {}, workspaceFolders: true },
          },
        },
        INIT_TIMEOUT_MS,
      );
      const legend = init?.capabilities?.semanticTokensProvider?.legend?.tokenTypes;
      if (legend?.length) this.tokenTypes = legend;
      rpc.notify('initialized', {});
    } catch (e) {
      this.fail(`initialize failed: ${(e as Error).message}`);
      throw e;
    }
    if (this.current.state === 'starting') this.set({ state: 'ready', command: this.opts.command });
  }

  private noteIndexing(chunk: string): void {
    const text = this.stderrTail + chunk;
    const nl = text.lastIndexOf('\n');
    this.stderrTail = nl === -1 ? text.slice(-200) : text.slice(nl + 1);
    // Both phrases in one chunk means the index finished before we looked.
    const indexing = INDEX_DONE.test(text) ? false : INDEX_START.test(text) ? true : null;
    if (indexing == null || this.current.state !== 'ready' || this.current.indexing === indexing) return;
    this.set({ ...this.current, indexing });
  }

  private fail(message: string): void {
    if (this.current.state === 'unavailable') return;
    this.set({ state: 'unavailable', command: this.opts.command, message });
    this.rpc?.dispose(new LspUnavailableError(message));
  }

  private set(status: LspStatus): void {
    this.current = status;
    this.opts.onStatus(status);
  }

  /** Waits for initialize; throws LspUnavailableError when the server is gone. */
  private async ensureReady(): Promise<JsonRpcConnection> {
    try {
      await this.ready;
    } catch {
      throw new LspUnavailableError(this.current.message ?? 'language server unavailable');
    }
    if (this.current.state !== 'ready' || !this.rpc)
      throw new LspUnavailableError(this.current.message ?? 'language server unavailable');
    return this.rpc;
  }

  /**
   * Opens or updates the document so the server sees the snapshot's text before
   * each request. Concurrent syncs of one path share a single read and
   * notification. Untracked documents beyond `maxOpen` are closed, least
   * recently used first; tracked ones stay open for the snapshot's lifetime.
   */
  private async sync(path: string): Promise<JsonRpcConnection> {
    const rpc = await this.ensureReady();
    let pending = this.syncing.get(path);
    if (!pending) {
      pending = this.syncNow(rpc, path).finally(() => this.syncing.delete(path));
      this.syncing.set(path, pending);
    }
    await pending;
    return rpc;
  }

  private async syncNow(rpc: JsonRpcConnection, path: string): Promise<void> {
    const text = await this.opts.read(path);
    if (text == null) throw new Error(`${path} is not in the snapshot`);
    const uri = this.uri(path);
    const doc = this.open.get(path);
    if (!doc) {
      this.open.set(path, { version: 1, text });
      rpc.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: isPython(path) ? 'python' : 'plaintext', version: 1, text },
      });
    } else {
      // Re-insert to mark it most recently used.
      this.open.delete(path);
      this.open.set(path, doc);
      if (doc.text !== text) {
        doc.version += 1;
        doc.text = text;
        rpc.notify('textDocument/didChange', {
          textDocument: { uri, version: doc.version },
          contentChanges: [{ text }],
        });
      }
    }
    this.evict(rpc);
  }

  /** Closes the least recently used untracked documents until at most `maxOpen` remain. */
  private evict(rpc: JsonRpcConnection): void {
    const max = this.opts.maxOpen ?? MAX_UNTRACKED_OPEN;
    let untracked = 0;
    for (const path of this.open.keys()) if (!this.tracked.has(path)) untracked++;
    for (const path of this.open.keys()) {
      if (untracked <= max) return;
      if (this.tracked.has(path) || this.syncing.has(path)) continue;
      this.open.delete(path);
      untracked--;
      rpc.notify('textDocument/didClose', { textDocument: { uri: this.uri(path) } });
    }
  }

  private uri(path: string): string {
    return pathToFileURL(join(this.opts.root, path)).href;
  }

  /**
   * Where each `file:` link in hover text points inside the repository: the repo-relative path and,
   * from the URI's `#line` or `#line,col` fragment, the 1-based line. Links outside the root are
   * left out, so the client never offers a jump it cannot make.
   */
  private async resolveLinks(md: string): Promise<Map<string, { path: string; line?: number }>> {
    const uris = fileLinkUris(md);
    const out = new Map<string, { path: string; line?: number }>();
    await Promise.all(
      uris.map(async (uri) => {
        const hash = uri.indexOf('#');
        const path = await this.pathOf(hash === -1 ? uri : uri.slice(0, hash));
        if (path == null) return;
        // Both fragment shapes servers write: `#12` / `#12,7` (pyright) and `#L12`.
        const line = hash === -1 ? null : /^L?(\d+)/.exec(uri.slice(hash + 1))?.[1];
        out.set(uri, line == null ? { path } : { path, line: Number(line) });
      }),
    );
    return out;
  }

  /**
   * Repo-relative path for a file URI inside the root; null otherwise. Compares
   * lexically first, then by realpath, so a canonicalized URI still matches a
   * root reached through a symlink (and vice versa).
   */
  private async pathOf(uri: string): Promise<string | null> {
    let abs: string;
    try {
      abs = fileURLToPath(uri);
    } catch {
      return null;
    }
    const lexical = relativeInside(this.opts.root, abs);
    if (lexical != null) return lexical;
    const real = await realpath(abs).catch(() => null);
    if (real == null) return null;
    return relativeInside(this.realRoot, real);
  }

  /**
   * Maps server locations to snapshot paths with the text of each line. Paths
   * resolve in parallel and each distinct file is read once, in parallel with
   * a limit, so a large reference set costs a bounded number of reads.
   */
  private async toLocations(locs: { uri: string; range: Range }[]): Promise<LspLocationsResponse> {
    const paths = await Promise.all(locs.map((l) => this.pathOf(l.uri)));
    const distinct = [...new Set(paths.filter((p): p is string => p != null))];
    const bodies = await mapLimit(
      distinct,
      READ_CONCURRENCY,
      async (p) => this.open.get(p)?.text ?? (await this.opts.read(p)),
    );
    const texts = new Map(distinct.map((p, i) => [p, bodies[i]!]));
    const out: LspLocation[] = [];
    let external = 0;
    let externalPath: string | undefined;
    let hidden = 0;
    let hiddenPath: string | undefined;
    locs.forEach((l, i) => {
      const path = paths[i];
      if (path == null) {
        external++;
        externalPath ??= safeFileURLToPath(l.uri);
        return;
      }
      const text = texts.get(path);
      if (text == null) {
        hidden++;
        hiddenPath ??= path;
        return;
      }
      const line = l.range.start.line + 1;
      out.push({ path, line, col: l.range.start.character, text: lineAt(text, line) });
    });
    const res: LspLocationsResponse = { locations: out, external, hidden };
    if (externalPath != null) res.externalPath = externalPath;
    if (hiddenPath != null) res.hiddenPath = hiddenPath;
    return res;
  }
}

/** `abs` relative to `root` when it lies inside it; null otherwise. */
function relativeInside(root: string, abs: string): string | null {
  const rel = relative(root, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split('\\').join('/');
}

function safeFileURLToPath(uri: string): string {
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
}

function safeRealpathSync(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function toLsp(pos: LspPosition): Position {
  return { line: Math.max(0, pos.line - 1), character: Math.max(0, pos.col) };
}

function normalizeLocations(r: null | Location | Location[] | LocationLink[]): { uri: string; range: Range }[] {
  if (!r) return [];
  const list = Array.isArray(r) ? r : [r];
  return list.map((x) => ('targetUri' in x ? { uri: x.targetUri, range: x.targetSelectionRange ?? x.targetRange } : x));
}

function isDocumentSymbols(r: DocumentSymbol[] | SymbolInformation[]): r is DocumentSymbol[] {
  return r.length > 0 && !('location' in r[0]!);
}

/**
 * `shell: true` runs the command under `sh -c`, so a plain kill would stop the
 * shell and orphan the language server. On POSIX the child leads its own process
 * group (`detached`), and shutdown signals the whole group.
 */
const DETACH = process.platform !== 'win32';

function lineAt(text: string, line: number): string {
  let start = 0;
  for (let i = 1; i < line; i++) {
    const nl = text.indexOf('\n', start);
    if (nl === -1) return '';
    start = nl + 1;
  }
  const end = text.indexOf('\n', start);
  return (end === -1 ? text.slice(start) : text.slice(start, end)).replace(/\r$/, '');
}

function lastLine(s: string): string {
  const lines = s.trim().split('\n');
  return lines[lines.length - 1] ?? '';
}
