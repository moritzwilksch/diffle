// Shared contract between server and client. Nothing else crosses that line.

export type Side = 'old' | 'new';

/** How the old side is resolved. Kept symbolic so live modes can re-resolve. */
export type OldSpec = { kind: 'rev'; rev: string } | { kind: 'merge-base'; a: string; b: string };

/** What the user asks for. Resolved by the server into a ModeSpec. */
export type ModeRequest = { kind: 'working' } | { kind: 'pr'; pr?: string } | { kind: 'revspec'; args: string[] };

export interface ModeSpec {
  kind: 'working' | 'pr' | 'revspec';
  /** The request that produced this spec. */
  request: ModeRequest;
  old: OldSpec;
  /** Symbolic rev (e.g. "HEAD", "feat") or the worktree. */
  newRev: string | 'worktree';
  /** Shown in the UI header. */
  label: string;
  /** The reviewed pull request; its base repository names the tab and header instead of the root directory. */
  pullRequest?: { repository: string; number: number };
  /** worktree: fs watch; refs: watch .git refs; none: static. */
  live: 'worktree' | 'refs' | 'none';
  /** Comment set key, fixed when the mode is entered. */
  commentKey: string;
}

export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U';

export interface ChangedFile {
  /** New path (or old path for deletions). */
  path: string;
  /** Set for R/C. */
  oldPath?: string;
  status: ChangeStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  /** New-side blob sha. '' for deletions. Keys the viewed state. */
  blob: string;
  /** A path pattern or a content sniff said this file is generated. Feeds auto-collapse and risk ranking. */
  generated: boolean;
  /** A gitlink (mode 160000): `blob` is the recorded commit, the patch shows the commit-id change, and there is no file to open. */
  submodule?: true;
}

export interface Snapshot {
  root: string;
  mode: ModeSpec;
  /** Monotonic; bumps on every refresh and mode switch. */
  version: number;
  oldSha: string;
  newSha: string | 'worktree';
  /** The checked-out commit; '' on an unborn branch. Symbol navigation needs newSha to be this or the worktree. */
  headSha: string;
  /** Context lines the patches were generated with. */
  context: number;
  changed: ChangedFile[];
  /** All paths on the new side: the new commit's tree, or index ∪ untracked for the worktree. Sorted. */
  tree: string[];
}

/** Body of `POST /api/patch`: the changed files whose patches to return, concatenated. Unknown paths are skipped. */
export interface PatchRequest {
  paths: string[];
}

export interface FileResponse {
  path: string;
  contents: string;
  binary: boolean;
}

export interface CommentAnchor {
  path: string;
  /** Column the user selected in a diff; 'new' for file items. */
  side: Side;
  startLine: number;
  endLine: number;
  /** Exact text of [startLine, endLine] at creation. */
  quoted: string;
}

export interface CommentMessage {
  id: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

/** A conversation anchored to a line range. The thread owns the anchor; replies follow it. */
export interface CommentThread {
  id: string;
  anchor: CommentAnchor;
  /** At least one; [0] opened the thread. */
  messages: CommentMessage[];
  resolved: boolean;
  resolvedAt?: number;
  /** Relocation failed after a snapshot refresh. */
  stale: boolean;
  /** Original startLine, shown in export when stale. */
  staleFromLine?: number;
}

/** Create payload. `quoted` is optional: the server quotes the range from the snapshot. */
export interface ThreadCreate {
  path: string;
  /** Default 'new'. */
  side?: Side;
  startLine: number;
  /** Default startLine. */
  endLine?: number;
  body: string;
  quoted?: string;
}

export interface ReplyCreate {
  body: string;
}

export type ThreadState = 'open' | 'resolved' | 'all';

/** Body of `POST /api/github/export`. Without `threadIds`, every unresolved thread of the mode. */
export interface GithubExportRequest {
  threadIds?: string[];
}

export interface GithubExportResponse {
  /** The pull request whose pending review the comments joined; the human submits the review there. */
  url: string;
  /** Review comments added to the pending review. */
  posted: number;
  /** Comments already in the pending review at the same anchor whose body this call rewrote in place. */
  updated: number;
  /** Whether this call opened the pending review or added to one that was already waiting. */
  review: 'created' | 'existing';
  /** Threads left out, with why (stale, resolved, unknown id, an identical comment already in the review). */
  skipped: { id: string; reason: string }[];
}

export interface ThreadQuery {
  /** Default 'open' for export, 'all' for list. */
  state?: ThreadState;
  path?: string;
}

export interface MessagePatch {
  body: string;
}

/** Explicit viewed/unviewed mark for a path at a specific new-side content. */
export interface ViewedEntry {
  path: string;
  blob: string;
  viewed: boolean;
}

export interface CommitInfo {
  sha: string;
  short: string;
  message: string;
}

/** Endpoints of HEAD~oldOffset..HEAD~newOffset, resolved against the same HEAD. Null means the commit does not exist. */
export interface LastCommitsPreview {
  old: CommitInfo | null;
  new: CommitInfo | null;
}

export interface RefsResponse {
  defaultBranch: string | null;
  current: string | null;
  branches: string[];
  remoteBranches: string[];
  tags: string[];
  recent: { sha: string; short: string; subject: string }[];
}

export interface SearchMatch {
  path: string;
  /** 1-based line on the new side. */
  line: number;
  text: string;
}

/** Where `/api/search` looks: one file (`path`), the diff's changed files (default), or the whole new-side tree. */
export type SearchScope = 'file' | 'diff' | 'repo';

export interface SearchResponse {
  query: string;
  matches: SearchMatch[];
  truncated: boolean;
}

export interface UserConfig {
  /** Globs (picomatch syntax) for files that start viewed + collapsed. Empty by default. */
  autoViewed: string[];
  /** Unchanged lines shown around each change (git -U). Default 5. */
  contextLines: number;
  /**
   * Language server command per language, replacing the built-in candidate for it; an empty
   * string disables the language. Read-only over HTTP; set with `diffle config set-lsp`.
   */
  lspCommands: Partial<Record<LanguageId, string>>;
}

export const DEFAULT_USER_CONFIG: UserConfig = {
  autoViewed: [],
  contextLines: 5,
  lspCommands: {},
};

/** A point in a new-side file. LSP semantics: the column counts UTF-16 units, like a JS string index. */
export interface LspPosition {
  path: string;
  /** 1-based. */
  line: number;
  /** 0-based UTF-16 offset in the line. */
  col: number;
}

export interface LspLocation extends LspPosition {
  /** The target line's text, for result lists. */
  text: string;
}

/** One language server process, as its bridge sees it. */
export interface LspProcessStatus {
  /** Program name, for messages: the basename of the command's first word, e.g. `pyrefly`. */
  name: string;
  /** The command line it was started from. */
  command: string;
  state: 'starting' | 'ready' | 'unavailable';
  message?: string;
  /** The server is building its workspace index; references in unopened files are incomplete until it finishes. Unset when the server does not say. */
  indexing?: boolean;
}

/** A process plus the languages the pool routes to it. */
export interface LspServerStatus extends LspProcessStatus {
  languages: LanguageId[];
}

/** A language in the diff with no server behind it. */
export interface LspMissing {
  language: LanguageId;
  /** Programs looked for on PATH, so the UI can name what to install. Empty when config turned the language off. */
  tried: string[];
}

export interface LspStatus {
  /** False with `--no-lsp`: no server will start for this run. */
  enabled: boolean;
  /** One entry per started server. Empty until a snapshot names a language with a server on PATH. */
  servers: LspServerStatus[];
  missing: LspMissing[];
}

export interface LspLocationsResponse {
  locations: LspLocation[];
  /** Results outside the repository root (stdlib, site-packages, another worktree), dropped. */
  external: number;
  /** Absolute path of the first external result, so the UI can say where the server looked. */
  externalPath?: string;
  /** Results inside the root that the snapshot hides (ignored dirs such as a venv), dropped. */
  hidden: number;
  /** Repo-relative path of the first hidden result, so the UI can say where the server looked. */
  hiddenPath?: string;
}

/** What the language server says about a position, for the hover tooltip. */
export interface LspHoverResponse {
  /** Markdown; null when the server has nothing for the position. */
  contents: string | null;
  /** The span the contents describe, when the server says. Same units as LspPosition. */
  range?: { line: number; col: number; endLine: number; endCol: number };
}

/** The semantic token class the server assigns a position: an LSP token type name such as `keyword` or `variable`. */
export interface LspTokenKindResponse {
  /** Null when the position is not inside a token or the server does not classify tokens. */
  kind: string | null;
}

export interface LspSymbol {
  name: string;
  /** LSP SymbolKind number; the client maps it to a label. */
  kind: number;
  /** Enclosing class or function, when any. */
  container?: string;
  path: string;
  line: number;
  /** Last line of the declaration's full range. */
  endLine: number;
  col: number;
}

/** Derived per changed file: 'restale' means viewed at an older blob. */
export type ViewedState = 'unviewed' | 'viewed' | 'restale';

export type ServerMessage =
  | { type: 'snapshot'; version: number }
  | { type: 'threads' }
  | { type: 'viewed' }
  | { type: 'config' }
  | { type: 'lsp'; payload: LspStatus };

/** True when the language server's view of the disk matches the snapshot's new side. */
export function followsCheckout(snap: Pick<Snapshot, 'newSha' | 'headSha'>): boolean {
  return snap.newSha === 'worktree' || (snap.headSha !== '' && snap.newSha === snap.headSha);
}

/**
 * A language diffle can start a server for. The value is the LSP `languageId` the
 * server is told in `didOpen`, so it must be the spec's spelling, not ours.
 */
export type LanguageId =
  | 'c'
  | 'cpp'
  | 'go'
  | 'haskell'
  | 'java'
  | 'javascript'
  | 'javascriptreact'
  | 'lua'
  | 'nix'
  | 'ocaml'
  | 'php'
  | 'python'
  | 'ruby'
  | 'rust'
  | 'shellscript'
  | 'swift'
  | 'terraform'
  | 'typescript'
  | 'typescriptreact'
  | 'zig';

/** Extension (no dot, lowercase) → language. `.h` goes to c because clangd serves both. */
const LANGUAGE_BY_EXT: Record<string, LanguageId> = {
  bash: 'shellscript',
  c: 'c',
  cc: 'cpp',
  cjs: 'javascript',
  cpp: 'cpp',
  cts: 'typescript',
  cxx: 'cpp',
  go: 'go',
  h: 'c',
  hh: 'cpp',
  hpp: 'cpp',
  hs: 'haskell',
  hxx: 'cpp',
  java: 'java',
  js: 'javascript',
  jsx: 'javascriptreact',
  lua: 'lua',
  mjs: 'javascript',
  ml: 'ocaml',
  mli: 'ocaml',
  mts: 'typescript',
  nix: 'nix',
  php: 'php',
  py: 'python',
  pyi: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'shellscript',
  swift: 'swift',
  tf: 'terraform',
  tfvars: 'terraform',
  ts: 'typescript',
  tsx: 'typescriptreact',
  zig: 'zig',
};

/** Every language diffle knows, sorted, for CLI validation and help. */
export const LANGUAGE_IDS: LanguageId[] = [...new Set(Object.values(LANGUAGE_BY_EXT))].sort();

/** The language of a path by extension, or null when diffle has no server for it. */
export function languageOf(path: string): LanguageId | null {
  const ext = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase();
  return (ext && LANGUAGE_BY_EXT[ext]) || null;
}

/**
 * Why the language server cannot answer for `path` — or, with no path, for a
 * repository-wide request — and null when it can. Shared so the client's flash and the
 * API's 409 say the same thing. The caller checks `followsCheckout` itself.
 */
export function lspBlocker(lsp: LspStatus, path?: string): string | null {
  if (!lsp.enabled) return 'Language servers are off for this run (--no-lsp)';
  if (path == null) {
    if (!lsp.servers.length) return noServer(lsp);
    return lsp.servers.some((s) => s.state === 'ready') ? null : notReady(lsp.servers[0]!);
  }
  const language = languageOf(path);
  if (!language) return `No language server for ${/(\.[^./\\]+)$/.exec(path)?.[1] ?? 'these'} files`;
  const server = lsp.servers.find((s) => s.languages.includes(language));
  if (!server) return noServer(lsp, language);
  return server.state === 'ready' ? null : notReady(server);
}

function notReady(s: LspServerStatus): string {
  return s.state === 'starting'
    ? `${s.name} is starting…`
    : `${s.name} is unavailable: ${s.message ?? 'unknown error'}`;
}

/** No server serves `language` (or nothing runs at all): say what the reader can do about it. */
function noServer(lsp: LspStatus, language?: LanguageId): string {
  const missing = language == null ? lsp.missing : lsp.missing.filter((m) => m.language === language);
  const absent = missing.filter((m) => m.tried.length > 0);
  const off = missing.filter((m) => m.tried.length === 0).map((m) => m.language);
  if (absent.length) {
    const langs = [...new Set(absent.map((m) => m.language))].join(', ');
    const programs = [...new Set(absent.flatMap((m) => m.tried))].join(', ');
    return `No language server for ${langs} on PATH: install one of ${programs}`;
  }
  if (off.length) return `The language server for ${off.join(', ')} is off in your diffle config`;
  return language == null ? 'No language server runs for this diff' : `No language server runs for ${language}`;
}
