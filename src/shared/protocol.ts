// Shared contract between server and client. Types are inferred from the wire schemas.
import { z } from 'zod';

/**
 * A language diffle can start a server for. The value is the LSP `languageId` the
 * server is told in `didOpen`, so it must be the spec's spelling, not ours.
 */
export const LanguageIdSchema = z.enum([
  'astro',
  'c',
  'cpp',
  'csharp',
  'css',
  'go',
  'haskell',
  'html',
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
  'vue',
  'yaml',
  'zig',
]);
export type LanguageId = z.infer<typeof LanguageIdSchema>;

export const SideSchema = z.enum(['old', 'new']);
export type Side = z.infer<typeof SideSchema>;

/**
 * What the CLI and the picker enter a review with: the words, parsed and resolved by the server
 * into a `Review`. A slice of the active range is chosen with a `RangeView` instead.
 */
export const EnterRequestSchema = z.discriminatedUnion('kind', [
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
  /** Two ranges compared as `git range-diff` takes them: `<a>..<b> <c>..<d>`, `<base> <b> <d>` or `<b>...<d>`. */
  z.object({
    kind: z.literal('range-diff'),
    args: z.string().array(),
  }),
]);
export type EnterRequest = z.infer<typeof EnterRequestSchema>;

/**
 * One state of a reviewed range: its resolved endpoints when a snapshot of it was taken. A new
 * one is recorded whenever the endpoints differ from the last, so a push, rebase or amend
 * yields the next iteration; the commits are pinned under `refs/diffle/iterations/`.
 */
export const IterationSchema = z.object({
  /** 1-based, in recording order. */
  n: z.number().int(),
  oldSha: z.string(),
  newSha: z.string(),
  /** Epoch milliseconds. */
  recordedAt: z.number().int(),
});
export type Iteration = z.infer<typeof IterationSchema>;

/** How a range's old side is derived: `old` itself, or merge-base(old, new) with the worktree taken as HEAD. */
export const ComparisonBaseSchema = z.enum(['direct', 'merge-base']);
export type ComparisonBase = z.infer<typeof ComparisonBaseSchema>;

/** What a snapshot follows: the worktree, the refs the range was named by, or nothing (pinned hashes, a pull request, an interdiff). */
export const LiveSchema = z.enum(['worktree', 'refs', 'none']);
export type Live = z.infer<typeof LiveSchema>;

/** One side of an interdiff: a recorded iteration of the range, or a range the reviewer named, `old..new`. */
export const RangeRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('iteration'), n: z.number().int().positive() }),
  z.object({ kind: z.literal('named'), old: z.string(), new: z.string() }),
]);
export type RangeRef = z.infer<typeof RangeRefSchema>;

/**
 * Which slice of a range is on screen. The range's commits stay listed whatever is shown.
 * - `whole`: the range itself.
 * - `commit`: one listed commit against its first parent.
 * - `uncommitted`: the uncommitted changes of a range that ends at the worktree.
 * - `interdiff`: what `to` (the range as it is now when absent) changed since `from`: `from`'s
 *   head replayed onto `to`'s base against `to`'s head, so a rebase in between does not show up
 *   as the upstream's changes. With `pair`, one pair of the two ranges' commits by its new-side
 *   hash: that commit against its old self replayed onto its parent, or against its parent when added.
 */
export const RangeViewSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('whole') }),
  z.object({ kind: z.literal('commit'), sha: z.string() }),
  z.object({ kind: z.literal('uncommitted') }),
  z.object({
    kind: z.literal('interdiff'),
    from: RangeRefSchema,
    to: RangeRefSchema.optional(),
    pair: z.string().optional(),
  }),
]);
export type RangeView = z.infer<typeof RangeViewSchema>;

/** The pull request a range was entered as: its identity, which keys its comments and names its export target. */
export const PullRefSchema = z.object({
  url: z.string(),
  number: z.number().int(),
  /** `owner/name` of the base repository. */
  repository: z.string(),
  /** `owner/name` of the head repository; null when it was deleted. */
  headRepository: z.string().nullable(),
});
export type PullRef = z.infer<typeof PullRefSchema>;

/**
 * What is under review, as named: a range between two revisions (either may be "worktree"), with
 * the slice of it on screen, or one commit against its first parent. Nothing here is resolved:
 * the snapshot carries the hashes, what the review follows and where its comments live.
 */
export const ReviewSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('range'),
    old: z.string(),
    new: z.string(),
    base: ComparisonBaseSchema,
    pr: PullRefSchema.optional(),
    view: RangeViewSchema,
  }),
  z.object({ kind: z.literal('commit'), sha: z.string() }),
]);
export type Review = z.infer<typeof ReviewSchema>;
export type RangeReview = Extract<Review, { kind: 'range' }>;

export const CommitInfoSchema = z.object({
  sha: z.string(),
  short: z.string(),
  message: z.string(),
});
export type CommitInfo = z.infer<typeof CommitInfoSchema>;

/** A single reviewed commit and its neighbours along HEAD's first-parent history, for stepping through it. */
export const ReviewedCommitSchema = CommitInfoSchema.extend({
  /** First parent; null for a root commit. */
  parent: z.string().nullable(),
  /** The commit whose first parent this is, toward HEAD; null at HEAD or off HEAD's first-parent line. */
  child: z.string().nullable(),
});
export type ReviewedCommit = z.infer<typeof ReviewedCommitSchema>;

/** One commit of the compared range. */
export const RangeCommitSchema = CommitInfoSchema.extend({
  author: z.string(),
  email: z.string(),
  /** Author date, epoch milliseconds. */
  date: z.number().int(),
});
export type RangeCommit = z.infer<typeof RangeCommitSchema>;

/** How a commit of the older iteration relates to one of the newer, as `git range-diff` pairs them. */
export const PairStatusSchema = z.enum(['identical', 'changed', 'message', 'added', 'dropped']);
export type PairStatus = z.infer<typeof PairStatusSchema>;

/**
 * One row of a range-diff: `identical` and `changed` pairs have both commits, a `message` pair
 * the same patch under a new message, an `added` commit no old side and a `dropped` one no new side.
 */
export const RangePairSchema = z.object({
  old: RangeCommitSchema.nullable(),
  new: RangeCommitSchema.nullable(),
  status: PairStatusSchema,
});
export type RangePair = z.infer<typeof RangePairSchema>;

/** A range's resolved endpoints, `oldSha..newSha`. */
export const RangeEndsSchema = z.object({
  oldSha: z.string(),
  newSha: z.string(),
});
export type RangeEnds = z.infer<typeof RangeEndsSchema>;

/** An interdiff view as the snapshot resolved it: the two ranges' commits and their pairing. */
export const InterdiffSchema = z.object({
  from: RangeEndsSchema,
  to: RangeEndsSchema,
  /** The two ranges' commits paired, in `git range-diff` order: the newer range's, dropped commits where they were. */
  pairs: RangePairSchema.array(),
  /** Paths the shown replay could not merge; they carry conflict markers on the old side. */
  conflicts: z.string().array(),
});
export type Interdiff = z.infer<typeof InterdiffSchema>;

/** The slice a range shows when nothing else is said. */
export const WHOLE: RangeView = { kind: 'whole' };

/** The two iterations an interdiff view compares, or null: it compares a named range, or the range is shown otherwise. */
export function shownIterations(review: Review): { from: number; to: number } | null {
  if (review.kind !== 'range' || review.view.kind !== 'interdiff') return null;
  const { from, to } = review.view;
  return from.kind === 'iteration' && to?.kind === 'iteration' ? { from: from.n, to: to.n } : null;
}

/**
 * What tells one review from another on the client: the range or commit with the slice shown.
 * A refresh keeps it; a view change or a switch changes it.
 */
export function reviewKey(review: Review): string {
  return JSON.stringify(review);
}

/** The key of the range a review sits in, whatever slice is shown; a lone commit keys itself. */
export function rangeKey(review: Review): string {
  return review.kind === 'range' ? reviewKey({ ...review, view: WHOLE }) : reviewKey(review);
}

/** The range the review sits in, shown whole, or null for a lone commit. */
export function rangeOf(review: Review): RangeReview | null {
  return review.kind === 'range' ? { ...review, view: WHOLE } : null;
}

/**
 * How the header names a review: branch names instead of internal ref namespaces; a lone commit
 * as `<sha>^!`; a range's slices as `<range> @ <sha>` or `<range> @ worktree`, `<range> #1→#2`
 * for two of its iterations, `<a>..<b> → <c>..<d>` against a named range, and ` @ <sha>` for one pair.
 */
export function comparisonLabel(review: Review): string {
  if (review.kind === 'commit') return `${review.sha.slice(0, 7)}^!`;
  const range = `${refName(review.old)}${review.base === 'merge-base' ? '...' : '..'}${refName(review.new)}`;
  const { view } = review;
  switch (view.kind) {
    case 'whole':
      return range;
    case 'commit':
      return `${range} @ ${view.sha.slice(0, 7)}`;
    case 'uncommitted':
      return `${range} @ worktree`;
    case 'interdiff': {
      const iterations = shownIterations(review);
      const side = (ref: RangeRef | undefined) =>
        ref == null ? range : ref.kind === 'iteration' ? `#${ref.n}` : rangeLabel(ref);
      const label = iterations
        ? `${range} #${iterations.from}→#${iterations.to}`
        : `${side(view.from)} → ${side(view.to)}`;
      return view.pair ? `${label} @ ${view.pair.slice(0, 7)}` : label;
    }
  }
}

/** One side of a range-diff as the reviewer named it, `<old>..<new>`, with full hashes abbreviated. */
export function rangeLabel(side: { old: string; new: string }): string {
  const short = (rev: string) => (/^[0-9a-f]{40}$/.test(rev) ? rev.slice(0, 7) : refName(rev));
  return `${short(side.old)}..${short(side.new)}`;
}

/** A comparison endpoint as the user named it: without diffle's PR namespace or `refs/heads/`. */
export function refName(rev: string): string {
  return rev.replace(/^refs\/diffle\/[^/]+\/\d+\/(?:base|head)\//, '').replace(/^refs\/(?:heads|remotes)\//, '');
}

export const GithubPullRequestSchema = z.object({
  repository: z.string(),
  number: z.number().int(),
  url: z.string(),
  title: z.string(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  isDraft: z.boolean(),
});
export type GithubPullRequest = z.infer<typeof GithubPullRequestSchema>;

/** Optional enrichment for a snapshot, independent of its comparison. */
export const GithubMetadataSchema = z.object({
  /** Snapshot.version used for this lookup; the client discards results for a different snapshot version. */
  version: z.number().int(),
  /** GitHub repository identified by the local origin URL. */
  repository: z.string().nullable(),
  /** Its page, on whichever GitHub the run talks to. */
  repositoryUrl: z.string().nullable(),
  pullRequest: GithubPullRequestSchema.nullable(),
  /** Null when export is allowed; otherwise explains why it is blocked. */
  reason: z.string().nullable(),
});
export type GithubMetadata = z.infer<typeof GithubMetadataSchema>;

/** Lines of one side of a snapshot to link to on the forge origin points at. */
export const PermalinkRequestSchema = z.object({
  /** Snapshot.version the lines were read from; another one is refused with a reason. */
  version: z.number().int(),
  /** The changed file's path; an old-side link follows a rename to its old path. */
  path: z.string(),
  side: SideSchema,
  startLine: z.number().int(),
  endLine: z.number().int(),
});
export type PermalinkRequest = z.infer<typeof PermalinkRequestSchema>;

/**
 * A link to lines at the commit their side shows, judged from local refs alone (no token, no
 * network, no cache, so a push shows on the next request), or why there is none.
 */
export const PermalinkSchema = z.object({
  url: z.string().nullable(),
  /** Why there is no link: no forge origin, the worktree, a review that changed, an unpushed commit. */
  reason: z.string().nullable(),
});
export type Permalink = z.infer<typeof PermalinkSchema>;

export const ChangeStatusSchema = z.enum(['A', 'M', 'D', 'R', 'C', 'T', 'U']);
export type ChangeStatus = z.infer<typeof ChangeStatusSchema>;

export const ChangedFileSchema = z.object({
  /** New path (or old path for deletions). */
  path: z.string(),
  /** Set for R/C. */
  oldPath: z.string().optional(),
  status: ChangeStatusSchema,
  additions: z.number().int(),
  deletions: z.number().int(),
  binary: z.boolean(),
  /** New-side blob sha. '' for deletions. Keys the viewed state. */
  blob: z.string(),
  /** Old-side blob sha. '' for additions. A worktree side's blob, like `blob`, is '' when the file cannot be hashed. */
  oldBlob: z.string(),
  /** The `linguist-generated` gitattribute, a path pattern or a content sniff said this file is generated. Feeds auto-collapse and risk ranking. */
  generated: z.boolean(),
  /** A gitlink (mode 160000): `blob` is the recorded commit, the patch shows the commit-id change, and there is no file to open. */
  submodule: z.literal(true).optional(),
});
export type ChangedFile = z.infer<typeof ChangedFileSchema>;

/**
 * The commits the review's range spans: old..new, with the worktree taken as HEAD; a lone commit lists itself.
 * Every slice of a range lists the range's.
 */
export const RangeCommitsSchema = z.object({
  /** Oldest first; the newest MAX_RANGE_COMMITS when there are more. */
  list: RangeCommitSchema.array(),
  total: z.number().int(),
  /** The spanned range's resolved endpoints: the snapshot's own when it shows the whole range. */
  oldSha: z.string(),
  newSha: z.string(),
});
export type RangeCommits = z.infer<typeof RangeCommitsSchema>;

export const MAX_RANGE_COMMITS = 250;

export const SnapshotSchema = z.object({
  root: z.string(),
  review: ReviewSchema,
  /** Monotonic; bumps on every refresh and mode switch. */
  version: z.number().int(),
  /** Resolved endpoints; either can be the worktree sentinel. An interdiff's old side is a replayed tree. */
  oldSha: z.string(),
  newSha: z.string(),
  /** The checked-out commit; '' on an unborn branch. Symbol navigation needs newSha to be this or the worktree. */
  headSha: z.string(),
  /** What the review follows: worktree edits recompute it, moved refs announce themselves, nothing for pinned sides. */
  follows: LiveSchema,
  /**
   * Where the review's threads and viewed marks live: fixed by what was entered, never by
   * discovery, so they survive pushes. An interdiff keeps viewed marks under a key of its own,
   * but takes no new threads: its old side is a replayed tree the range never shows again.
   */
  commentKey: z.string(),
  /** Set for an interdiff view: how it was resolved. */
  interdiff: InterdiffSchema.optional(),
  /** Context lines the patches were generated with. */
  context: z.number().int(),
  changed: ChangedFileSchema.array(),
  /** All paths on the new side: the new commit's tree, or index ∪ untracked for the worktree. Sorted. */
  tree: z.string().array(),
  /** The shown commit, with its neighbours: a lone commit, a focused one, or an added commit of an interdiff pair; otherwise null. */
  commit: ReviewedCommitSchema.nullable(),
  commits: RangeCommitsSchema,
  /** The recorded iterations of the range `commits` spans, oldest first; empty for comparisons that are not followed. */
  iterations: IterationSchema.array(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

/**
 * The compared refs resolve elsewhere than when the shown snapshot was taken. A refs-live
 * comparison is not recomputed under the reviewer; it reloads on request.
 */
export const MovedSchema = z.object({
  /** The snapshot a reload would supersede. */
  version: z.number().int(),
  /** Where the comparison `Snapshot.commits` spans resolves now. */
  oldSha: z.string(),
  newSha: z.string(),
});
export type Moved = z.infer<typeof MovedSchema>;

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
  startLine: z.number().int(),
  endLine: z.number().int(),
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
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type CommentMessage = z.infer<typeof CommentMessageSchema>;

/** A conversation anchored to a line range or a whole file. The thread owns the anchor; replies follow it. */
export const CommentThreadSchema = z.object({
  id: z.string(),
  anchor: CommentAnchorSchema,
  /** At least one; [0] opened the thread. */
  messages: CommentMessageSchema.array().min(1),
  resolved: z.boolean(),
  resolvedAt: z.number().int().optional(),
  /** Relocation failed after a snapshot refresh: the lines left the diff, or the file left the review. */
  stale: z.boolean(),
  /** Original startLine of a line thread, shown in export when stale. */
  staleFromLine: z.number().int().optional(),
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
  posted: z.number().int(),
  /** Comments already in the pending review at the same anchor whose body this call rewrote in place. */
  updated: z.number().int(),
  /** Whether this call opened the pending review or added to one that was already waiting. */
  review: z.enum(['created', 'existing']),
  /** Threads left out, with why (stale, resolved, unknown id, an identical comment already in the review). */
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
  line: z.number().int(),
  text: z.string(),
});
export type SearchMatch = z.infer<typeof SearchMatchSchema>;

/** Where `/api/search` looks: one file (`path`), the diff's changed files (default), or the whole new-side tree. */
export const SearchScopeSchema = z.enum(['file', 'diff', 'repo']);
export type SearchScope = z.infer<typeof SearchScopeSchema>;

/** Whether search includes whole files or only new-side diff hunks and their context. */
export const SearchContentSchema = z.enum(['diff', 'full']);
export type SearchContent = z.infer<typeof SearchContentSchema>;

export const SearchResponseSchema = z.object({
  query: z.string(),
  matches: SearchMatchSchema.array(),
  truncated: z.boolean(),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

/**
 * How a review between refs reacts when one of them moves. `on`: recompute at once, as a worktree
 * review follows edits. `off`: announce the move and wait for Reload. `auto`: wait for Reload when an
 * endpoint names a branch, whose pushes and rebases should not swap the review out under the
 * reviewer; recompute at once otherwise (a detached HEAD, a tag, an expression).
 */
export const FollowRefsSchema = z.enum(['on', 'auto', 'off']);
export type FollowRefs = z.infer<typeof FollowRefsSchema>;

export const UserConfigSchema = z.object({
  /** Globs (picomatch syntax) for files that start viewed + collapsed. Empty by default. */
  autoViewed: z.string().array(),
  /** Unchanged lines shown around each change (git -U). Default 5. */
  contextLines: z.number().int(),
  /** When a review between refs recomputes as its refs move; see `FollowRefsSchema`. Default auto. */
  followRefs: FollowRefsSchema,
  /** Wrap long lines in the viewer instead of scrolling them sideways. Default true. */
  lineWrap: z.boolean(),
  /**
   * Language server command per language, replacing the built-in candidate for it; an empty
   * string disables the language. Read-only over HTTP; set in the config file, whose path `diffle config` prints.
   */
  lspCommands: z.partialRecord(LanguageIdSchema, z.string()),
  /**
   * GitHub Enterprise hosts: the host in remote urls → the host serving the web UI and API, the
   * same one for most. github.com needs no entry. Read-only over HTTP; set by editing the
   * config file.
   */
  githubHosts: z.record(z.string(), z.string()),
});
export type UserConfig = z.infer<typeof UserConfigSchema>;

export const DEFAULT_USER_CONFIG: UserConfig = {
  autoViewed: [],
  contextLines: 5,
  followRefs: 'auto',
  lineWrap: true,
  lspCommands: {},
  githubHosts: {},
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
   * `/api/file` serves it on the new side, read-only, and the servers that named it answer queries from it,
   * for as long as they keep naming it.
   */
  external: z.literal(true).optional(),
});
export type LspLocation = z.infer<typeof LspLocationSchema>;

/**
 * `POST /api/lsp/hover`. `ownerOnly` asks the file's own server alone: a server joining the
 * language, such as Tailwind's, adds notes for markup that read as noise on a declaration.
 */
export const LspHoverRequestSchema = LspPositionSchema.extend({ ownerOnly: z.boolean().optional() });
export type LspHoverRequest = z.infer<typeof LspHoverRequestSchema>;

/** One language server process, as its bridge sees it. */
export const LspStateSchema = z.enum(['starting', 'ready', 'unavailable']);
export type LspState = z.infer<typeof LspStateSchema>;

export const LspNoticeSchema = z.object({
  severity: z.enum(['warning', 'error']),
  message: z.string(),
});
export type LspNotice = z.infer<typeof LspNoticeSchema>;

export const LspLogCountsSchema = z.object({
  /** Changes whenever a line is added or repeated, so a reader showing the log knows to fetch again. */
  seq: z.number().int().nonnegative(),
  /** Error and warning lines since the server started, kept or not. */
  errors: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative(),
});
export type LspLogCounts = z.infer<typeof LspLogCountsSchema>;

export const LspProcessStatusSchema = z.object({
  /** Program name, for messages: the basename of the command's first word, e.g. `pyrefly`. */
  name: z.string(),
  /** The command line it was started from. */
  command: z.string(),
  /** `ready` means initialized; LSP has no universal workspace-ready signal. */
  state: LspStateSchema,
  message: z.string().optional(),
  /** Active work reported through LSP work-done progress; absent when none is reported. */
  activity: z.string().array().optional(),
  /**
   * What the server last said to the reader through `window/showMessage`, when it was a
   * warning or an error. Its log never stands here: that is `log`.
   */
  notice: LspNoticeSchema.optional(),
  /** The server's output channel in brief; `GET /api/lsp/log` lists the lines. */
  log: LspLogCountsSchema,
});
export type LspProcessStatus = z.infer<typeof LspProcessStatusSchema>;

/** Where a log line came from: `window/showMessage`, `window/logMessage`, or the process's stderr. */
export const LspLogSourceSchema = z.enum(['message', 'log', 'stderr']);
export type LspLogSource = z.infer<typeof LspLogSourceSchema>;
export const LspLogLevelSchema = z.enum(['error', 'warning', 'info', 'log']);
export type LspLogLevel = z.infer<typeof LspLogLevelSchema>;

/** One line of a server's output channel. The bridge keeps a bounded number of recent ones. */
export const LspLogEntrySchema = z.object({
  /** Stable identity of the line within the run. */
  id: z.number().int().positive(),
  /** Milliseconds since the epoch, of its latest repeat. */
  time: z.number().int(),
  source: LspLogSourceSchema,
  level: LspLogLevelSchema,
  message: z.string(),
  /** How many times in a row the server said exactly this. */
  count: z.number().int().positive(),
});
export type LspLogEntry = z.infer<typeof LspLogEntrySchema>;

/** `GET /api/lsp/log?server=<command>`: the retained lines of one server, oldest first. */
export const LspLogQuerySchema = z.object({ server: z.string().min(1) });
export const LspLogResponseSchema = z.object({ entries: LspLogEntrySchema.array() });
export type LspLogResponse = z.infer<typeof LspLogResponseSchema>;

/**
 * A request the bridge sends a server only once it advertised the capability, in its
 * `initialize` result or by registering it later, as an editor does. Document highlights
 * are advisory: without them the answer is empty, never an error.
 */
export const LspFeatureSchema = z.enum([
  'definition',
  'typeDefinition',
  'hover',
  'references',
  'documentSymbol',
  'workspaceSymbol',
  'documentHighlight',
]);
export type LspFeature = z.infer<typeof LspFeatureSchema>;

/** Where diffle pointed a server, found from the diff's files: which project's code it reads. */
export const LspProjectsSchema = z.object({
  /** What it was pointed at, e.g. `TypeScript 5.9.3` or `Cargo workspaces`. */
  label: z.string(),
  /** Repository-relative, else `~`-abbreviated or absolute. Empty when nothing was found. */
  paths: z.string().array(),
});
export type LspProjects = z.infer<typeof LspProjectsSchema>;

/** A process plus the languages the pool routes to it. */
export const LspServerStatusSchema = LspProcessStatusSchema.extend({
  /** Languages it owns: asked first, and alone for highlights, token kinds and outlines. */
  languages: LanguageIdSchema.array(),
  /** Languages it answers for beside their owner, such as Tailwind's class hovers in markup. */
  joins: LanguageIdSchema.array(),
  /** What its `initialize` result advertised; empty while starting. */
  supports: LspFeatureSchema.array(),
  /** Absent for a server diffle points at no project. */
  projects: LspProjectsSchema.optional(),
});
export type LspServerStatus = z.infer<typeof LspServerStatusSchema>;

/** A language in the diff with no server behind it. */
export const LspMissingSchema = z.object({
  language: LanguageIdSchema,
  /** Programs looked for on PATH, so the UI can name what to install. Empty when config turned the language off. */
  tried: z.string().array(),
  /**
   * A program that is on PATH but lacks what the server loads from beside it, such as a
   * `vue-language-server` without its tsserver plugin: installing more is not the answer.
   */
  why: z.string().optional(),
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

/**
 * Why an empty answer may be incomplete: the server reported background work (indexing, loading
 * the workspace) while answering, or a server that would also have answered was unavailable.
 * Never set beside a non-empty answer.
 */
const inconclusive = z.string().optional();

/** Results the server could place: snapshot paths, or files it read from disk on the language server's word. */
export const LspLocationsResponseSchema = z.object({
  locations: LspLocationSchema.array(),
  inconclusive,
});
export type LspLocationsResponse = z.infer<typeof LspLocationsResponseSchema>;

/** What the language server says about a position, for the hover tooltip. */
export const LspHoverResponseSchema = z.object({
  /** Markdown; null when the server has nothing for the position. */
  contents: z.string().nullable(),
  /** The span the contents describe, when the server says. Same units as LspPosition. */
  range: z
    .object({
      line: z.number().int(),
      col: z.number().int(),
      endLine: z.number().int(),
      endCol: z.number().int(),
    })
    .optional(),
  inconclusive,
});
export type LspHoverResponse = z.infer<typeof LspHoverResponseSchema>;

/** One place a symbol occurs in its own file, from `textDocument/documentHighlight`. Same units as LspPosition. */
export const LspOccurrenceSchema = z.object({
  line: z.number().int().positive(),
  col: z.number().int().nonnegative(),
  endLine: z.number().int().positive(),
  endCol: z.number().int().nonnegative(),
  /** LSP DocumentHighlightKind: a plain textual match, a read, or a write. */
  kind: z.enum(['text', 'read', 'write']),
});
export type LspOccurrence = z.infer<typeof LspOccurrenceSchema>;

/** Every occurrence of the symbol at a position in the same file; empty when the server has none or no opinion. */
export const LspOccurrencesResponseSchema = z.object({
  occurrences: LspOccurrenceSchema.array(),
});
export type LspOccurrencesResponse = z.infer<typeof LspOccurrencesResponseSchema>;

export const LspSymbolSchema = z.object({
  name: z.string(),
  /** LSP SymbolKind number; the client maps it to a label. */
  kind: z.number().int(),
  /** Enclosing class or function, when any. */
  container: z.string().optional(),
  path: z.string(),
  /** Line of the name, where navigation lands. */
  line: z.number().int(),
  /** First line of the declaration's full range, before `line` when a decorator or doc comment leads it. */
  startLine: z.number().int(),
  /** Last line of the declaration's full range. */
  endLine: z.number().int(),
  col: z.number().int(),
});
export type LspSymbol = z.infer<typeof LspSymbolSchema>;

/** `GET /api/lsp/symbols`: a file's outline with `path`, else the repository's symbols matching `q`. */
export const LspSymbolsResponseSchema = z.object({ symbols: LspSymbolSchema.array(), inconclusive });
export type LspSymbolsResponse = z.infer<typeof LspSymbolsResponseSchema>;

/** A changed symbol carries its change; a `consumer` is unchanged code that uses one. */
export const GraphNodeStatusSchema = z.enum(['added', 'modified', 'consumer']);
export type GraphNodeStatus = z.infer<typeof GraphNodeStatusSchema>;

/**
 * A symbol in the change graph: an interface-level symbol the diff touches, or an unchanged one
 * using it. A consumer used from a file's top level, outside any symbol, is that file: kind 1 (File),
 * named by its path, at line 1.
 */
export const GraphNodeSchema = LspSymbolSchema.extend({
  /** `path:line:col` of the symbol's name, or the path of a file-level consumer. Stable within a snapshot. */
  id: z.string(),
  status: GraphNodeStatusSchema,
  /** Consumers left out beyond the per-symbol cap; changed symbols only. */
  moreConsumers: z.number().int().optional(),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

/** `from` uses `to`: the language server lists places inside `from` among `to`'s references. */
export const GraphEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  /** Lines in `from`'s file holding those references, ascending. */
  lines: z.number().int().array(),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

/** `GET /api/lsp/graph`: the snapshot's changed symbols and the code using them, from the language servers. */
export const GraphResponseSchema = z.object({
  nodes: GraphNodeSchema.array(),
  edges: GraphEdgeSchema.array(),
  /** Changed symbols past the server's cap, by whole files, most telling first; drawn with `GraphQuery.all`. */
  cut: GraphNodeSchema.array(),
  /** Why the graph may lack nodes or edges: a server was busy or unavailable while answering. */
  inconclusive: z.string().optional(),
});
export type GraphResponse = z.infer<typeof GraphResponseSchema>;

/** Derived per changed file: 'restale' means viewed at an older blob. */
export const ViewedStateSchema = z.enum(['unviewed', 'viewed', 'restale']);
export type ViewedState = z.infer<typeof ViewedStateSchema>;

export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('snapshot'),
    version: z.number().int(),
  }),
  /** Null once the refs are back where the snapshot has them. */
  z.object({
    type: z.literal('moved'),
    moved: MovedSchema.nullable(),
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
  astro: 'astro',
  bash: 'shellscript',
  c: 'c',
  cc: 'cpp',
  cjs: 'javascript',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  cts: 'typescript',
  cxx: 'cpp',
  go: 'go',
  h: 'c',
  hh: 'cpp',
  hpp: 'cpp',
  hs: 'haskell',
  htm: 'html',
  html: 'html',
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
  vue: 'vue',
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

/** Writable HTTP config fields; unknown keys, including CLI-only lspCommands and githubHosts, are stripped. */
export const ConfigUpdateSchema = z.object({
  autoViewed: z.string().array().optional(),
  contextLines: z.number().int().min(0).max(10_000).optional(),
  followRefs: FollowRefsSchema.optional(),
  lineWrap: z.boolean().optional(),
});
export type ConfigUpdate = z.infer<typeof ConfigUpdateSchema>;
export const ResolvedRequestSchema = z.object({ resolved: z.boolean() });
export const ViewedBulkRequestSchema = z.object({ entries: ViewedEntrySchema.array() });
export const FileQuerySchema = z.object({ path: z.string().min(1), rev: SideSchema });
/**
 * `GET /api/image`: one side of a file as image bytes. The server answers 404 unless `key` is that side's
 * `imageKey` in its current snapshot, the bytes are still the ones the key names, and they are a raster image.
 */
export const ImageQuerySchema = FileQuerySchema.extend({ key: z.string().min(1) });

/**
 * Names the bytes of one side of `path`, or null when the side has no name: a changed file's blob on that
 * side, else the commit of a side that is one, since an unchanged path is alike on both. What a key names
 * never changes, so an image served under it may be cached for good.
 */
export function imageKey(
  snap: Pick<Snapshot, 'changed' | 'oldSha' | 'newSha'>,
  path: string,
  side: Side,
): string | null {
  const file = snap.changed.find((f) => f.path === path);
  if (file) return (side === 'new' ? file.blob : file.oldBlob) || null;
  return [snap.newSha, snap.oldSha].find((rev) => rev !== 'worktree') ?? null;
}
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
  content: SearchContentSchema.default('diff'),
  path: z.string().optional(),
  word: flagSchema,
  i: flagSchema,
  re: flagSchema,
});
export const SymbolsQuerySchema = z
  .object({ path: z.string().min(1).optional(), q: z.string().optional() })
  .refine((query) => query.path != null || query.q != null, 'path or q required');
export type SymbolsQuery = z.infer<typeof SymbolsQuerySchema>;
/**
 * `GET /api/lsp/graph`: `all` lifts the cap on changed symbols; `scope`, a folder without its
 * trailing slash, graphs only the changed files under it, whose dependents may live anywhere.
 */
export const GraphQuerySchema = z.object({ all: z.literal('1').optional(), scope: z.string().min(1).optional() });
export type GraphQuery = z.infer<typeof GraphQuerySchema>;
export const ClearThreadsQuerySchema = z.object({ stale: z.literal('1').optional() });
export const PatchQuerySchema = z.object({ path: z.string().optional() });
export const ApiErrorSchema = z.object({ error: z.string() });
