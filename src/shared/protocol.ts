// Shared contract between server and client. Types are inferred from the wire schemas.
import { z } from 'zod';

/**
 * A language diffle can start a server for. The value is the LSP `languageId` the
 * server is told in `didOpen`, so it must be the spec's spelling, not ours.
 */
export const LanguageIdSchema = z.enum([
  'c',
  'cpp',
  'go',
  'haskell',
  'java',
  'javascript',
  'javascriptreact',
  'json',
  'jsonc',
  'lua',
  'nix',
  'ocaml',
  'php',
  'python',
  'ruby',
  'rust',
  'shellscript',
  'swift',
  'terraform',
  'toml',
  'typescript',
  'typescriptreact',
  'yaml',
  'zig',
]);
export type LanguageId = z.infer<typeof LanguageIdSchema>;

export const SideSchema = z.enum(['old', 'new']);
export type Side = z.infer<typeof SideSchema>;

/** CLI and picker commands are translated into a comparison before rendering. */
export const ModeRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('working'),
  }),
  z.object({
    kind: z.literal('pr'),
    pr: z.string().optional(),
  }),
  z.object({
    kind: z.literal('revspec'),
    args: z.string().array(),
  }),
]);
export type ModeRequest = z.infer<typeof ModeRequestSchema>;

/** A comparison; both endpoints accept a Git revision or "worktree". */
export const ModeSpecSchema = z.object({
  old: z.string(),
  new: z.string(),
  /** Compare merge-base(old, new) to new; worktree uses HEAD for the merge base. */
  mergeBase: z.boolean(),
  live: z.enum(['worktree', 'refs', 'none']),
  /** Fixed when the comparison is entered; discovery never changes comment storage. */
  commentKey: z.string(),
});
export type ModeSpec = z.infer<typeof ModeSpecSchema>;

/** Display comparison endpoints with branch names instead of internal ref namespaces. */
export function comparisonLabel(mode: Pick<ModeSpec, 'old' | 'new' | 'mergeBase'>): string {
  const name = (rev: string) =>
    rev.replace(/^refs\/diffle\/[^/]+\/\d+\/(?:base|head)\//, '').replace(/^refs\/(?:heads|remotes)\//, '');
  return `${name(mode.old)}${mode.mergeBase ? '...' : '..'}${name(mode.new)}`;
}

export const GithubPullRequestSchema = z.object({
  repository: z.string(),
  number: z.number(),
  url: z.string(),
  title: z.string(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  isDraft: z.boolean(),
});
export type GithubPullRequest = z.infer<typeof GithubPullRequestSchema>;

/** Optional enrichment for a snapshot, independent of its comparison. */
export const GithubMetadataSchema = z.object({
  /** Snapshot.version used for this lookup; the client discards results for a different snapshot version. */
  version: z.number(),
  /** GitHub repository identified by the local origin URL. */
  repository: z.string().nullable(),
  pullRequest: GithubPullRequestSchema.nullable(),
  /** Null when export is allowed; otherwise explains why it is blocked. */
  reason: z.string().nullable(),
});
export type GithubMetadata = z.infer<typeof GithubMetadataSchema>;

export const ChangeStatusSchema = z.enum(['A', 'M', 'D', 'R', 'C', 'T', 'U']);
export type ChangeStatus = z.infer<typeof ChangeStatusSchema>;

export const ChangedFileSchema = z.object({
  /** New path (or old path for deletions). */
  path: z.string(),
  /** Set for R/C. */
  oldPath: z.string().optional(),
  status: ChangeStatusSchema,
  additions: z.number(),
  deletions: z.number(),
  binary: z.boolean(),
  /** New-side blob sha. '' for deletions. Keys the viewed state. */
  blob: z.string(),
  /** The `linguist-generated` gitattribute, a path pattern or a content sniff said this file is generated. Feeds auto-collapse and risk ranking. */
  generated: z.boolean(),
  /** A gitlink (mode 160000): `blob` is the recorded commit, the patch shows the commit-id change, and there is no file to open. */
  submodule: z.literal(true).optional(),
});
export type ChangedFile = z.infer<typeof ChangedFileSchema>;

export const SnapshotSchema = z.object({
  root: z.string(),
  mode: ModeSpecSchema,
  /** Monotonic; bumps on every refresh and mode switch. */
  version: z.number(),
  /** Resolved endpoints; either can be the worktree sentinel. */
  oldSha: z.string(),
  newSha: z.string(),
  /** The checked-out commit; '' on an unborn branch. Symbol navigation needs newSha to be this or the worktree. */
  headSha: z.string(),
  /** Context lines the patches were generated with. */
  context: z.number(),
  changed: ChangedFileSchema.array(),
  /** All paths on the new side: the new commit's tree, or index ∪ untracked for the worktree. Sorted. */
  tree: z.string().array(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

/** Body of `POST /api/patch`: the changed files whose patches to return, concatenated. Unknown paths are skipped. */
export const PatchRequestSchema = z.object({
  paths: z.string().array().max(200),
});
export type PatchRequest = z.infer<typeof PatchRequestSchema>;

export const FileResponseSchema = z.object({
  path: z.string(),
  contents: z.string(),
  binary: z.boolean(),
});
export type FileResponse = z.infer<typeof FileResponseSchema>;

/** A thread on a line range of one side. */
export const LineAnchorSchema = z.object({
  kind: z.literal('line'),
  path: z.string(),
  /** Column the user selected in a diff; 'new' for file items. */
  side: SideSchema,
  startLine: z.number(),
  endLine: z.number(),
  /** Exact text of [startLine, endLine] at creation. */
  quoted: z.string(),
});
export type LineAnchor = z.infer<typeof LineAnchorSchema>;

/** A thread on a file as a whole, with no line: GitHub's file-level comment. */
export const FileAnchorSchema = z.object({
  kind: z.literal('file'),
  /** The changed file's path (its new path for a rename), or any tree path. */
  path: z.string(),
});
export type FileAnchor = z.infer<typeof FileAnchorSchema>;

export const CommentAnchorSchema = z.discriminatedUnion('kind', [LineAnchorSchema, FileAnchorSchema]);
export type CommentAnchor = z.infer<typeof CommentAnchorSchema>;

export const CommentMessageSchema = z.object({
  id: z.string(),
  body: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type CommentMessage = z.infer<typeof CommentMessageSchema>;

/** A conversation anchored to a line range or a whole file. The thread owns the anchor; replies follow it. */
export const CommentThreadSchema = z.object({
  id: z.string(),
  anchor: CommentAnchorSchema,
  /** At least one; [0] opened the thread. */
  messages: CommentMessageSchema.array().min(1),
  resolved: z.boolean(),
  resolvedAt: z.number().optional(),
  /** Relocation failed after a snapshot refresh: the lines left the diff, or the file left the review. */
  stale: z.boolean(),
  /** Original startLine of a line thread, shown in export when stale. */
  staleFromLine: z.number().optional(),
});
export type CommentThread = z.infer<typeof CommentThreadSchema>;

/**
 * Create payload. Without `startLine` the thread is on the file as a whole; then `side`,
 * `endLine` and `quoted` are refused rather than ignored, so a payload that meant a line
 * never lands on the file. `quoted` is optional: the server quotes the range from the snapshot.
 */
export const ThreadCreateSchema = z
  .object({
    path: z.string().min(1),
    /** Default 'new'. */
    side: SideSchema.optional(),
    startLine: z.number().int().positive().optional(),
    /** Default startLine. */
    endLine: z.number().int().positive().optional(),
    body: z.string().refine((body) => body.trim().length > 0, 'body required'),
    quoted: z.string().optional(),
  })
  .refine((t) => t.startLine == null || t.endLine == null || t.endLine >= t.startLine, {
    path: ['endLine'],
    message: 'endLine must be ≥ startLine',
  })
  .refine((t) => t.startLine != null || (t.side == null && t.endLine == null && t.quoted == null), {
    path: ['startLine'],
    message: 'side, endLine and quoted need a startLine; leave all four out for a comment on the whole file',
  });
export type ThreadCreate = z.infer<typeof ThreadCreateSchema>;

export const ReplyCreateSchema = z.object({
  body: z.string().refine((body) => body.trim().length > 0, 'body required'),
});
export type ReplyCreate = z.infer<typeof ReplyCreateSchema>;

export const ThreadStateSchema = z.enum(['open', 'resolved', 'all']);
export type ThreadState = z.infer<typeof ThreadStateSchema>;

/** Body of `POST /api/github/export`. Without `threadIds`, every unresolved thread of the mode. */
export const GithubExportRequestSchema = z.object({
  threadIds: z.string().array().optional(),
});
export type GithubExportRequest = z.infer<typeof GithubExportRequestSchema>;

export const GithubExportResponseSchema = z.object({
  /** The pull request whose pending review the comments joined; the human submits the review there. */
  url: z.string(),
  /** Review comments added to the pending review. */
  posted: z.number(),
  /** Comments already in the pending review at the same anchor whose body this call rewrote in place. */
  updated: z.number(),
  /** Whether this call opened the pending review or added to one that was already waiting. */
  review: z.enum(['created', 'existing']),
  /** Threads left out, with why (stale, outside the diff or its hunks, unknown id, an identical comment already in the review). */
  skipped: z
    .object({
      id: z.string(),
      reason: z.string(),
    })
    .array(),
});
export type GithubExportResponse = z.infer<typeof GithubExportResponseSchema>;

export const ThreadQuerySchema = z.object({
  /** Default 'open' for export, 'all' for list. */
  state: ThreadStateSchema.optional(),
  path: z.string().optional(),
});
export type ThreadQuery = z.infer<typeof ThreadQuerySchema>;

export const MessagePatchSchema = z.object({
  body: z.string(),
});
export type MessagePatch = z.infer<typeof MessagePatchSchema>;

/** Explicit viewed/unviewed mark for a path at a specific new-side content. */
export const ViewedEntrySchema = z.object({
  path: z.string(),
  blob: z.string(),
  viewed: z.boolean(),
});
export type ViewedEntry = z.infer<typeof ViewedEntrySchema>;

export const CommitInfoSchema = z.object({
  sha: z.string(),
  short: z.string(),
  message: z.string(),
});
export type CommitInfo = z.infer<typeof CommitInfoSchema>;

/** Endpoints of HEAD~oldOffset..HEAD~newOffset, resolved against the same HEAD. Null means the commit does not exist. */
export const LastCommitsPreviewSchema = z.object({
  old: CommitInfoSchema.nullable(),
  new: CommitInfoSchema.nullable(),
});
export type LastCommitsPreview = z.infer<typeof LastCommitsPreviewSchema>;

export const RefsResponseSchema = z.object({
  defaultBranch: z.string().nullable(),
  current: z.string().nullable(),
  branches: z.string().array(),
  remoteBranches: z.string().array(),
  tags: z.string().array(),
  recent: z
    .object({
      sha: z.string(),
      short: z.string(),
      subject: z.string(),
    })
    .array(),
});
export type RefsResponse = z.infer<typeof RefsResponseSchema>;

export const SearchMatchSchema = z.object({
  path: z.string(),
  /** 1-based line on the new side. */
  line: z.number(),
  text: z.string(),
});
export type SearchMatch = z.infer<typeof SearchMatchSchema>;

/** Where `/api/search` looks: one file (`path`), the diff's changed files (default), or the whole new-side tree. */
export const SearchScopeSchema = z.enum(['file', 'diff', 'repo']);
export type SearchScope = z.infer<typeof SearchScopeSchema>;

export const SearchResponseSchema = z.object({
  query: z.string(),
  matches: SearchMatchSchema.array(),
  truncated: z.boolean(),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

export const UserConfigSchema = z.object({
  /** Globs (picomatch syntax) for files that start viewed + collapsed. Empty by default. */
  autoViewed: z.string().array(),
  /** Unchanged lines shown around each change (git -U). Default 5. */
  contextLines: z.number(),
  /**
   * Language server command per language, replacing the built-in candidate for it; an empty
   * string disables the language. Read-only over HTTP; set with `diffle config set-lsp`.
   */
  lspCommands: z.partialRecord(LanguageIdSchema, z.string()),
});
export type UserConfig = z.infer<typeof UserConfigSchema>;

export const DEFAULT_USER_CONFIG: UserConfig = {
  autoViewed: [],
  contextLines: 5,
  lspCommands: {},
};

/** A point in a new-side file. LSP semantics: the column counts UTF-16 units, like a JS string index. */
export const LspPositionSchema = z.object({
  path: z.string().min(1),
  /** 1-based. */
  line: z.number().int().positive(),
  /** 0-based UTF-16 offset in the line. */
  col: z.number().int().nonnegative(),
});
export type LspPosition = z.infer<typeof LspPositionSchema>;

export const LspLocationSchema = LspPositionSchema.extend({
  /** The target line's text, for result lists. */
  text: z.string(),
  /**
   * The file is not in the snapshot (stdlib, site-packages, an ignored venv) and `path` is absolute.
   * `/api/file` serves it on the new side, read-only, for as long as the language server keeps naming it.
   */
  external: z.literal(true).optional(),
});
export type LspLocation = z.infer<typeof LspLocationSchema>;

/** One language server process, as its bridge sees it. */
export const LspProcessStatusSchema = z.object({
  /** Program name, for messages: the basename of the command's first word, e.g. `pyrefly`. */
  name: z.string(),
  /** The command line it was started from. */
  command: z.string(),
  /** `ready` means initialized; LSP has no universal workspace-ready signal. */
  state: z.enum(['starting', 'ready', 'unavailable']),
  message: z.string().optional(),
  /** Active work reported through LSP work-done progress; absent when none is reported. */
  activity: z.string().array().optional(),
  /** Last warning or error reported by the server, not a process failure. */
  notice: z
    .object({
      severity: z.enum(['warning', 'error']),
      message: z.string(),
    })
    .optional(),
  /** Bounded stderr tail for servers that report failures only through their process output. */
  stderr: z.string().optional(),
});
export type LspProcessStatus = z.infer<typeof LspProcessStatusSchema>;

/** A process plus the languages the pool routes to it. */
export const LspServerStatusSchema = LspProcessStatusSchema.extend({
  languages: LanguageIdSchema.array(),
});
export type LspServerStatus = z.infer<typeof LspServerStatusSchema>;

/** A language in the diff with no server behind it. */
export const LspMissingSchema = z.object({
  language: LanguageIdSchema,
  /** Programs looked for on PATH, so the UI can name what to install. Empty when config turned the language off. */
  tried: z.string().array(),
});
export type LspMissing = z.infer<typeof LspMissingSchema>;

export const LspStatusSchema = z.object({
  /** False with `--no-lsp`: no server will start for this run. */
  enabled: z.boolean(),
  /** One entry per started server. Empty until a snapshot names a language with a server on PATH. */
  servers: LspServerStatusSchema.array(),
  missing: LspMissingSchema.array(),
});
export type LspStatus = z.infer<typeof LspStatusSchema>;

/** Results the server could place: snapshot paths, or files it read from disk on the language server's word. */
export const LspLocationsResponseSchema = z.object({
  locations: LspLocationSchema.array(),
});
export type LspLocationsResponse = z.infer<typeof LspLocationsResponseSchema>;

/** What the language server says about a position, for the hover tooltip. */
export const LspHoverResponseSchema = z.object({
  /** Markdown; null when the server has nothing for the position. */
  contents: z.string().nullable(),
  /** The span the contents describe, when the server says. Same units as LspPosition. */
  range: z
    .object({
      line: z.number(),
      col: z.number(),
      endLine: z.number(),
      endCol: z.number(),
    })
    .optional(),
});
export type LspHoverResponse = z.infer<typeof LspHoverResponseSchema>;

/** The semantic token class the server assigns a position: an LSP token type name such as `keyword` or `variable`. */
export const LspTokenKindResponseSchema = z.object({
  /** Null when the position is not inside a token or the server does not classify tokens. */
  kind: z.string().nullable(),
});
export type LspTokenKindResponse = z.infer<typeof LspTokenKindResponseSchema>;

export const LspSymbolSchema = z.object({
  name: z.string(),
  /** LSP SymbolKind number; the client maps it to a label. */
  kind: z.number(),
  /** Enclosing class or function, when any. */
  container: z.string().optional(),
  path: z.string(),
  line: z.number(),
  /** Last line of the declaration's full range. */
  endLine: z.number(),
  col: z.number(),
});
export type LspSymbol = z.infer<typeof LspSymbolSchema>;

/** Derived per changed file: 'restale' means viewed at an older blob. */
export const ViewedStateSchema = z.enum(['unviewed', 'viewed', 'restale']);
export type ViewedState = z.infer<typeof ViewedStateSchema>;

export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('snapshot'),
    version: z.number(),
  }),
  z.object({
    type: z.literal('threads'),
  }),
  z.object({
    type: z.literal('viewed'),
  }),
  z.object({
    type: z.literal('config'),
  }),
  z.object({
    type: z.literal('lsp'),
    payload: LspStatusSchema,
  }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

/** True when the language server's view of the disk matches the snapshot's new side. */
export function followsCheckout(snap: Pick<Snapshot, 'newSha' | 'headSha'>): boolean {
  return snap.newSha === 'worktree' || (snap.headSha !== '' && snap.newSha === snap.headSha);
}

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
  json: 'json',
  jsonc: 'jsonc',
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
  toml: 'toml',
  ts: 'typescript',
  tsx: 'typescriptreact',
  yaml: 'yaml',
  yml: 'yaml',
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

/** Writable HTTP config fields; unknown keys, including CLI-only lspCommands, are stripped. */
export const ConfigUpdateSchema = z.object({
  autoViewed: z.string().array().optional(),
  contextLines: z.number().int().min(0).max(10_000).optional(),
});
export type ConfigUpdate = z.infer<typeof ConfigUpdateSchema>;
export const ResolvedRequestSchema = z.object({ resolved: z.boolean() });
export const ViewedBulkRequestSchema = z.object({ entries: ViewedEntrySchema.array() });
export const FileQuerySchema = z.object({ path: z.string().min(1), rev: SideSchema });
const offsetSchema = z
  .string()
  .regex(/^[0-9]+$/)
  .transform(Number)
  .pipe(z.number().int().nonnegative());
export const LastCommitsQuerySchema = z.object({ oldOffset: offsetSchema, newOffset: offsetSchema });
const flagSchema = z
  .enum(['0', '1'])
  .optional()
  .transform((value) => value === '1');
export const SearchQuerySchema = z.object({
  q: z.string().default(''),
  scope: SearchScopeSchema.default('diff'),
  path: z.string().optional(),
  word: flagSchema,
  i: flagSchema,
  re: flagSchema,
});
export const SymbolsQuerySchema = z
  .object({ path: z.string().min(1).optional(), q: z.string().optional() })
  .refine((query) => query.path != null || query.q != null, 'path or q required');
export type SymbolsQuery = z.infer<typeof SymbolsQuerySchema>;
export const ClearThreadsQuerySchema = z.object({ stale: z.literal('1').optional() });
export const PatchQuerySchema = z.object({ path: z.string().optional() });
export const ApiErrorSchema = z.object({ error: z.string() });
