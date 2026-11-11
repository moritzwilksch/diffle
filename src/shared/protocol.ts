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

/** A selection in a tour element's reading text: what the reader sees, as `diffle --skill` defines it. */
export const TourTextTargetSchema = z.object({
  on: z.literal('text'),
  /** The selected text, whitespace runs collapsed to one space. */
  quoted: z.string(),
  /** Which match of `quoted` in the element's reading text, 0-based, whitespace ignored. */
  occurrence: z.number().int(),
});
export type TourTextTarget = z.infer<typeof TourTextTargetSchema>;

/** A tour element as a whole: a block, a diagram box or a diagram label. */
export const TourElementTargetSchema = z.object({
  on: z.literal('element'),
  /** What finds it again: a card's title, a box's text, a diff's path and lines; '' for none. */
  label: z.string(),
});
export type TourElementTarget = z.infer<typeof TourElementTargetSchema>;

/** The part of a tour element a thread is on. */
export const TourTargetSchema = z.discriminatedUnion('on', [TourTextTargetSchema, TourElementTargetSchema]);
export type TourTarget = z.infer<typeof TourTargetSchema>;

/** The part of a tour element a new thread is on; the server labels an element. */
export const TourTargetRequestSchema = z.discriminatedUnion('on', [
  TourTextTargetSchema,
  z.object({ on: z.literal('element') }),
]);
export type TourTargetRequest = z.infer<typeof TourTargetRequestSchema>;

/** A thread on the review's tour, at the element `node` names and the part of it `target` names. */
export const TourAnchorSchema = z.object({
  kind: z.literal('tour'),
  /** Child-element indices from the document's `<body>` to the element, in the tour as last pushed. */
  node: z.number().int().array(),
  /** The 1-based number of the `h2` section it sits in; absent before the first. */
  step: z.number().int().optional(),
  /** That section's heading text; '' before the first. */
  section: z.string(),
  /** The element as a refused push names it, after its diagram or card: `diffle-card#auth > <p>`. */
  element: z.string(),
  target: TourTargetSchema,
});
export type TourAnchor = z.infer<typeof TourAnchorSchema>;

export const CommentAnchorSchema = z.discriminatedUnion('kind', [LineAnchorSchema, FileAnchorSchema, TourAnchorSchema]);
export type CommentAnchor = z.infer<typeof CommentAnchorSchema>;

/** Who wrote a message that the reviewer did not: only `diffle comments` sends it, never the browser. */
export const CommentAuthorSchema = z.enum(['agent']);
export type CommentAuthor = z.infer<typeof CommentAuthorSchema>;

export const CommentMessageSchema = z.object({
  id: z.string(),
  body: z.string(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  /** Absent: the reviewer wrote it. */
  author: CommentAuthorSchema.optional(),
});
export type CommentMessage = z.infer<typeof CommentMessageSchema>;

/** A conversation anchored to a line range, a whole file, or a part of the tour. The thread owns the anchor; replies follow it. */
export const CommentThreadSchema = z.object({
  id: z.string(),
  anchor: CommentAnchorSchema,
  /** At least one; [0] opened the thread. */
  messages: CommentMessageSchema.array().min(1),
  resolved: z.boolean(),
  resolvedAt: z.number().int().optional(),
  /** Relocation failed: the lines left the diff, the file left the review, or the tour lost the passage. */
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
    /** Absent: the reviewer opens the thread. */
    author: CommentAuthorSchema.optional(),
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

/**
 * `POST /api/tour/threads`: opens a thread on the review's tour as it is now. The server names the
 * section and the element, and an element's label, from the stored tour.
 */
export const TourThreadCreateSchema = z.object({
  node: z.number().int().array(),
  target: TourTargetRequestSchema,
  body: z.string().refine((body) => body.trim().length > 0, 'body required'),
});
export type TourThreadCreate = z.infer<typeof TourThreadCreateSchema>;

export const ReplyCreateSchema = z.object({
  body: z.string().refine((body) => body.trim().length > 0, 'body required'),
  /** Absent: the reviewer replies. */
  author: CommentAuthorSchema.optional(),
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

/** An item of a `diffle-check` in the stored tour, with what the reviewer did with it. */
export const TourCheckItemSchema = z.object({
  /** Child-element indices from `<body>` to the item, as a tour anchor's `node`. */
  node: z.number().int().array(),
  /** The `h2` it sits under: its 1-based number; absent before the first. */
  step: z.number().int().optional(),
  section: z.string(),
  /** Its reading text, whitespace collapsed: what finds it again in a revised tour. */
  question: z.string(),
  /** Whether the reviewer ticked it as decided. */
  ticked: z.boolean(),
  /** The open thread that answers it, when there is one. */
  thread: z.string().optional(),
});
export type TourCheckItem = z.infer<typeof TourCheckItemSchema>;

/** What `GET /api/threads` answers: the threads of the set the reviewer is shown, read under one key. */
export const ThreadListSchema = z.object({
  /** The set the threads belong to: `Snapshot.commentKey` of the slice shown when they were read. */
  commentKey: z.string(),
  threads: CommentThreadSchema.array(),
  /** The items of the tour's checklists, each with whether it is ticked and the thread answering it. */
  checks: TourCheckItemSchema.array(),
});
export type ThreadList = z.infer<typeof ThreadListSchema>;

export const MessagePatchSchema = z.object({
  body: z.string(),
  /** Absent: the reviewer edits. */
  author: CommentAuthorSchema.optional(),
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

/** A card's `id`. Letters, digits, `-` and `_`, starting with a letter. */
const tourIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
/** A positive integer, as an HTML attribute spells it. */
const tourNumberSchema = z.string().regex(/^[1-9][0-9]*$/);
/** A line range on one side, `40-58`, or one line, `40`. */
const tourLinesSchema = z.string().regex(/^[1-9][0-9]*(-[1-9][0-9]*)?$/);
/** A Lucide icon by its name on lucide.dev: `database`, `shield-check`. */
const tourIconNameSchema = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

/**
 * A framed explainer for one part of the diff, a block in the article's flow: its title, a sentence
 * or two, and the `diffle-diff`s it explains. It holds what prose holds, except headings and cards.
 */
export const TourCardSchema = z
  .object({
    tag: z.literal('diffle-card'),
    /** Unique in the tour. Letters, digits, `-` and `_`, starting with a letter. */
    id: tourIdSchema,
    /** What this part of the diff does, as the card's heading. */
    title: z.string().min(1),
    /** A Lucide icon before the title, by its name on lucide.dev. */
    icon: tourIconNameSchema.optional(),
  })
  .strict();

/**
 * A Lucide icon inside a line of text (prose, a heading, a table cell), at the text's size and
 * colour. It marks one kind of thing the same way throughout the tour. It holds nothing.
 */
export const TourIconSchema = z
  .object({
    tag: z.literal('diffle-icon'),
    /** Its name on lucide.dev: `database`, `shield-check`. */
    name: tourIconNameSchema,
    /** A colour in place of the text's: `accent`, or `success`, `warning` and `error` for status. */
    tone: z.enum(['accent', 'success', 'warning', 'error']).optional(),
  })
  .strict();

/** Lines of the review's diff, highlighted, with a jump to them. It holds nothing. */
export const TourDiffSchema = z
  .object({
    tag: z.literal('diffle-diff'),
    /** A file of the review, relative to the repository root; a renamed file by its new path. */
    path: z.string().min(1),
    /** Which side's line numbers `lines` counts: `old` (before) or `new` (after, the default). */
    side: SideSchema.optional(),
    /** The line range on that side, `40-58`, or one line, `40`. */
    lines: tourLinesSchema,
  })
  .strict();

/**
 * Lines of the review's diff walked one note at a time, a block in the article's flow: the reader
 * steps through its `diffle-note`s in order, and each lights its lines and dims the rest. It holds
 * only its notes.
 */
export const TourWalkSchema = z
  .object({
    tag: z.literal('diffle-walk'),
    /** A file of the review, relative to the repository root; a renamed file by its new path. */
    path: z.string().min(1),
    /** Which side's line numbers `lines` and its notes' `lines` count: `old` or `new` (the default). */
    side: SideSchema.optional(),
    /** The line range the walk shows, `12-30`. */
    lines: tourLinesSchema,
  })
  .strict();

/**
 * One step of a `diffle-walk` or a stepped `diffle-diagram`: a title and a sentence or two, in
 * inline prose (`code`, `strong`, `em`, `a`, `diffle-symbol`, `diffle-jump`, `diffle-icon`).
 */
export const TourNoteSchema = z
  .object({
    tag: z.literal('diffle-note'),
    /** In a walk, the lines it explains, within the walk's, on its side: `14-17`, or `14`. A diagram's note takes none: it explains the step of its number. */
    lines: tourLinesSchema.optional(),
    /** What these lines do, in a few words: `Record each sale`. */
    title: z.string().min(1),
  })
  .strict();

/**
 * A path through the code in call order, a block in the article's flow: the reader steps through
 * its `diffle-stop`s, each a few lines of a file around one line, lit, with a sentence. It holds
 * only its stops.
 */
export const TourTraceSchema = z
  .object({
    tag: z.literal('diffle-trace'),
  })
  .strict();

/**
 * One stop of a `diffle-trace`: a line of a file of the review and a sentence about what happens
 * there, in inline prose (`code`, `strong`, `em`, `a`, `diffle-symbol`, `diffle-jump`, `diffle-icon`).
 */
export const TourStopSchema = z
  .object({
    tag: z.literal('diffle-stop'),
    /** A file of the review, relative to the repository root. */
    path: z.string().min(1),
    /** The line the stop lights; a few lines around it show too. */
    line: tourNumberSchema,
    /** Which side `line` counts on: `old` or `new` (the default). */
    side: SideSchema.optional(),
  })
  .strict();

/**
 * Two to four panes side by side in one block's width, one shown at a time: the chosen design next
 * to one it rejected, a payload before and after. It holds only its `diffle-tab`s.
 */
export const TourTabsSchema = z
  .object({
    tag: z.literal('diffle-tabs'),
  })
  .strict();

/** What a tab's pane is to the reader, shown as a chip beside its title. */
export const TourTabKindSchema = z.enum(['chosen', 'rejected', 'example']);
export type TourTabKind = z.infer<typeof TourTabKindSchema>;

/** One pane of a `diffle-tabs`. It holds what a card holds: prose and blocks, no headings or other tabs. */
export const TourTabSchema = z
  .object({
    tag: z.literal('diffle-tab'),
    /** What the pane shows, in a few words, on its tab. */
    title: z.string().min(1),
    /** A chip beside the title: `chosen`, `rejected` or `example`. */
    kind: TourTabKindSchema.optional(),
  })
  .strict();

/**
 * Questions the reviewer decides, a block in the article's flow: each `diffle-item` is ticked as
 * decided or answered in a thread the agent reads. It holds only its items.
 */
export const TourCheckSchema = z
  .object({
    tag: z.literal('diffle-check'),
  })
  .strict();

/** A question of a `diffle-check`, one line of inline prose: what the reviewer should decide. */
export const TourItemSchema = z
  .object({
    tag: z.literal('diffle-item'),
    /** A sentence of context under the question: what the choice costs or what it rests on. */
    context: z.string().min(1).optional(),
  })
  .strict();

/** A language the highlighter knows, by its id: `rust`, `typescript`, `python`. */
const tourLangSchema = z.string().regex(/^[a-z0-9][a-z0-9+#-]*$/);

/**
 * Code the agent writes: signatures, interfaces, type definitions, the shape of an abstraction,
 * never code the diff already shows. Highlighted like the diff; with `path`, framed with the file's
 * path and a jump to it. With `example`, a snippet the agent made up to show how something works
 * (data as it flows, a simplified spike, an alternative design), labelled as an example. It holds
 * its code as text, `<` written `&lt;`.
 */
export const TourCodeSchema = z
  .object({
    tag: z.literal('diffle-code'),
    /** The highlighter's language; required without `path`, which otherwise names it. */
    lang: tourLangSchema.optional(),
    /** The file of the review the code comes from, relative to the repository root. */
    path: z.string().min(1).optional(),
    /** Where in `path`, on the new side, its first declaration sits. */
    line: tourNumberSchema.optional(),
    /** Written bare, as an HTML boolean attribute: the code is made up, not from the repository. It takes no `path` or `line`. */
    example: z.string().optional(),
    /** What an example shows, beside its label: `Response to POST /login`. */
    title: z.string().min(1).optional(),
  })
  .strict();

/**
 * A directory tree of some files under a title; changed ones show their status and line counts. It
 * holds only `diffle-file` notes, on a few of its files.
 */
export const TourTreeSchema = z
  .object({
    tag: z.literal('diffle-tree'),
    /** What its files are, in a few words, as its header: `Server · Rust`. */
    title: z.string().min(1),
    /** A Lucide icon before the title, by its name on lucide.dev. */
    icon: tourIconNameSchema.optional(),
    /** Files of the review, one per line, relative to the repository root. */
    paths: z.string().min(1),
    /** The folder the tree starts at, without a trailing `/`; every path lies under it. Default: the repository root. */
    root: z.string().min(1).optional(),
  })
  .strict();

/**
 * A note beside one file of its `diffle-tree`: a few words of inline prose on where to start or what
 * surprises, never the file's name again.
 */
export const TourFileSchema = z
  .object({
    tag: z.literal('diffle-file'),
    /** One of its tree's `paths`. */
    path: z.string().min(1),
  })
  .strict();

/**
 * A button that opens the diff view at a file or a line. Its text is the label, plain text: markup
 * inside it is refused. Empty, it shows `path:line`.
 */
export const TourJumpSchema = z
  .object({
    tag: z.literal('diffle-jump'),
    /** A file of the review, relative to the repository root. */
    path: z.string().min(1),
    /** The line to land on; without it, the file's first change. */
    line: tourNumberSchema.optional(),
    /** Which side `line` counts on: `old` or `new` (the default). */
    side: SideSchema.optional(),
  })
  .strict();

/**
 * A symbol the prose names, anchored to its line: coloured as the diff colours it there, with the
 * diff's hover card and a click that lists its references when a language server serves its file.
 * It holds nothing.
 */
export const TourSymbolSchema = z
  .object({
    tag: z.literal('diffle-symbol'),
    /** A file of the review, relative to the repository root. */
    path: z.string().min(1),
    /** The line `name` is on. */
    line: tourNumberSchema,
    /** The symbol, exactly as it appears on that line. */
    name: z.string().min(1),
    /** Which side `line` counts on: `old` or `new` (the default). */
    side: SideSchema.optional(),
  })
  .strict();

/** A highlighted aside, a block in the article's flow or in a card. It holds what a card holds, except another callout. */
export const TourCalloutSchema = z
  .object({
    tag: z.literal('diffle-callout'),
    /** `info` for context, `warning` for something the reviewer should check, `danger` for a likely bug or breaking change. */
    kind: z.enum(['info', 'warning', 'danger']),
  })
  .strict();

/**
 * A simple architecture diagram, a block in the article's flow: one inline `<svg>` of
 * `TourSvgElement`s, drawn by hand; with steps, a `diffle-note` per step after it.
 */
export const TourDiagramSchema = z
  .object({
    tag: z.literal('diffle-diagram'),
  })
  .strict();

/** A coordinate or length in diagram units; one unit is one pixel. */
const svgNumberSchema = z.string().regex(/^-?[0-9]+(\.[0-9]+)?$/);
/** Coordinate pairs, `x,y x,y ...`. */
const svgPointsSchema = z.string().regex(/^[0-9.,\s-]+$/);
/** A path's commands and numbers, such as `M168 116 H240`. */
const svgPathSchema = z.string().regex(/^[MmLlHhVvCcSsQqZz0-9.,\s-]+$/);
/** Words of `TourSvgClass`, separated by spaces. */
const svgClassSchema = z.string();

/**
 * An element of a diagram's `<svg>`, with its geometry. diffle styles each from its classes and the
 * theme and draws the arrowheads, so none takes `style`, `fill`, `stroke`, fonts or markers.
 */
export const TourSvgElementSchema = z.discriminatedUnion('tag', [
  z
    .object({
      tag: z.literal('svg'),
      /** `0 0 <width> <height>`; one unit is one pixel. */
      viewBox: z.string().regex(/^0 0 [1-9][0-9]* [1-9][0-9]*$/),
    })
    .strict(),
  z
    .object({
      tag: z.literal('g'),
      class: svgClassSchema.optional(),
      /** The step of a stepped diagram that lights this group; the diagram holds one `diffle-note` per step. */
      step: tourNumberSchema.optional(),
    })
    .strict(),
  z
    .object({
      tag: z.literal('rect'),
      x: svgNumberSchema,
      y: svgNumberSchema,
      width: svgNumberSchema,
      height: svgNumberSchema,
      class: svgClassSchema.optional(),
    })
    .strict(),
  z
    .object({
      tag: z.literal('circle'),
      cx: svgNumberSchema,
      cy: svgNumberSchema,
      r: svgNumberSchema,
      class: svgClassSchema.optional(),
    })
    .strict(),
  z
    .object({
      tag: z.literal('ellipse'),
      cx: svgNumberSchema,
      cy: svgNumberSchema,
      rx: svgNumberSchema,
      ry: svgNumberSchema,
      class: svgClassSchema.optional(),
    })
    .strict(),
  z.object({ tag: z.literal('polygon'), points: svgPointsSchema, class: svgClassSchema.optional() }).strict(),
  z.object({ tag: z.literal('polyline'), points: svgPointsSchema, class: svgClassSchema.optional() }).strict(),
  z.object({ tag: z.literal('path'), d: svgPathSchema, class: svgClassSchema.optional() }).strict(),
  z
    .object({
      tag: z.literal('line'),
      x1: svgNumberSchema,
      y1: svgNumberSchema,
      x2: svgNumberSchema,
      y2: svgNumberSchema,
      class: svgClassSchema.optional(),
    })
    .strict(),
  z
    .object({
      tag: z.literal('text'),
      x: svgNumberSchema,
      y: svgNumberSchema,
      class: svgClassSchema.optional(),
      /** With the class `code`: the highlighter's language for its lines, one `tspan` each. */
      lang: tourLangSchema.optional(),
    })
    .strict(),
  z
    .object({
      tag: z.literal('tspan'),
      x: svgNumberSchema.optional(),
      y: svgNumberSchema.optional(),
      dx: svgNumberSchema.optional(),
      dy: svgNumberSchema.optional(),
      class: svgClassSchema.optional(),
    })
    .strict(),
]);
export type TourSvgElement = z.infer<typeof TourSvgElementSchema>;

/**
 * A Lucide icon in a diagram: an `<svg>` nested in the drawing, holding nothing. It takes its text's
 * colour, or the tone of its group or its own class.
 */
export const TourSvgIconSchema = z
  .object({
    tag: z.literal('svg'),
    /** Its name on lucide.dev: `database`, `shield-check`. */
    'data-lucide': tourIconNameSchema,
    /** Its top-left corner. */
    x: svgNumberSchema,
    y: svgNumberSchema,
    /** Its width and height; 14 by default. */
    size: svgNumberSchema.optional(),
    class: svgClassSchema.optional(),
  })
  .strict();
export type TourSvgIcon = z.infer<typeof TourSvgIconSchema>;

/**
 * The classes that style a diagram. Lines: `arrow` (a head at the end), `arrows` (both ends),
 * `dashed`. Text: `bold`, `small`, `mono`, `code` (lines of code in its `lang`, one `tspan` each,
 * highlighted), `c` (centred on `x`), `e` (ends at `x`), `eyebrow` (a region's label). Surfaces: `fill` (a gray face), `frame` (a dashed container without a face).
 * Tones, on a shape, group, line or text: `accent` for what the point is about, `success`,
 * `warning` and `error` for status.
 */
export const TourSvgClassSchema = z.enum([
  'arrow',
  'arrows',
  'dashed',
  'bold',
  'small',
  'mono',
  'code',
  'c',
  'e',
  'eyebrow',
  'fill',
  'frame',
  'accent',
  'success',
  'warning',
  'error',
]);
export type TourSvgClass = z.infer<typeof TourSvgClassSchema>;

/**
 * Two or three columns side by side while the window has room, stacked below that, at the top
 * level. Each column is a block (`diffle-card`, `diffle-code`, `diffle-diff`, `diffle-diagram`, `diffle-tree`,
 * `diffle-callout`, `table`) or short prose (`div`, `p`, `ul`, `ol`).
 */
export const TourRowSchema = z
  .object({
    tag: z.literal('diffle-row'),
  })
  .strict();

/** A `diffle-*` element of a tour with its attributes, which are strings as in HTML. */
export const TourElementSchema = z.discriminatedUnion('tag', [
  TourCardSchema,
  TourDiffSchema,
  TourTreeSchema,
  TourJumpSchema,
  TourSymbolSchema,
  TourCalloutSchema,
  TourDiagramSchema,
  TourRowSchema,
  TourCodeSchema,
  TourIconSchema,
  TourWalkSchema,
  TourNoteSchema,
  TourTraceSchema,
  TourStopSchema,
  TourTabsSchema,
  TourTabSchema,
  TourCheckSchema,
  TourItemSchema,
  TourFileSchema,
]);
export type TourElement = z.infer<typeof TourElementSchema>;
export type TourElementTag = TourElement['tag'];

/**
 * The plain tags a tour is written in: `h1` titles it, each `h2` starts a section, a step of the
 * walk, and `h3` a subsection; `h4` is a small heading inside a card, a tab, a callout or a
 * `details`, where those cannot go. The rest carry prose, lists and tables, and `details` folds away
 * what the main path can do without, opening with its `summary`. They take no
 * attributes, except `a`, which takes an `href` to an `http(s)` URL, and `th` and `td`, which take
 * `colspan` and `rowspan` as positive numbers.
 */
export const TourTagSchema = z.enum([
  'h1',
  'h2',
  'h3',
  'h4',
  'p',
  'ul',
  'ol',
  'li',
  'code',
  'pre',
  'strong',
  'em',
  'a',
  'div',
  'details',
  'summary',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
]);
export type TourTag = z.infer<typeof TourTagSchema>;

/** The review's tour: one HTML document, as the agent last pushed it. */
export const TourSchema = z.object({
  html: z.string(),
  /** Milliseconds since the epoch. */
  pushedAt: z.number().int(),
  /** The `Snapshot.version` the tour was checked against when pushed. */
  version: z.number().int(),
  /** The questions of its checklists the reviewer ticked as decided, each as `TourCheckItem.question`. */
  ticked: z.string().array().optional(),
});
export type Tour = z.infer<typeof TourSchema>;

/** `PUT /api/tour/ticks`: ticks a checklist item as decided, or unticks it. */
export const TourTickSchema = z.object({ question: z.string(), ticked: z.boolean() });
export type TourTick = z.infer<typeof TourTickSchema>;

/** `PUT /api/tour`: replaces the review's tour. */
export const TourPushSchema = z.object({ html: z.string() });
export type TourPush = z.infer<typeof TourPushSchema>;

/** `GET /api/tour`: the review's tour, or null without one. */
export const TourResponseSchema = z.object({
  tour: TourSchema.nullable(),
  /** Its checklists' items in document order. */
  checks: TourCheckItemSchema.array(),
});
export type TourResponse = z.infer<typeof TourResponseSchema>;

/** One reason a pushed tour was refused, or one warning about an accepted one. */
export const TourErrorSchema = z.object({
  /** The culprit as the document spells it, with the card it sits in: `diffle-card#auth > diffle-diff path="a.rs"`. */
  element: z.string(),
  message: z.string(),
});
export type TourError = z.infer<typeof TourErrorSchema>;

/**
 * What `PUT /api/tour` answers for an accepted tour: the tour as stored, and warnings in document
 * order. A warning is a judgment call, such as a diagram label that may run past its box; the
 * agent fixes it or keeps it knowingly.
 */
export const TourPushedSchema = z.object({ tour: TourSchema, warnings: TourErrorSchema.array() });
export type TourPushed = z.infer<typeof TourPushedSchema>;

/** What `PUT /api/tour` answers with 422: every reason, in document order. */
export const TourRejectionSchema = z.object({ errors: TourErrorSchema.array() });
export type TourRejection = z.infer<typeof TourRejectionSchema>;

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
    /** After the change this announces; `GET /api/threads/activity` takes it as `since`. */
    cursor: z.string(),
  }),
  z.object({
    type: z.literal('viewed'),
  }),
  z.object({
    type: z.literal('config'),
  }),
  /** The review's tour was pushed or cleared; `GET /api/tour` answers the new one. */
  z.object({
    type: z.literal('tour'),
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
export const ResolvedRequestSchema = z.object({
  resolved: z.boolean(),
  /** Absent: the reviewer resolves or reopens. */
  author: CommentAuthorSchema.optional(),
});
export const ViewedBulkRequestSchema = z.object({ entries: ViewedEntrySchema.array() });
export const FileQuerySchema = z.object({ path: z.string().min(1), rev: SideSchema });

/** What a highlighted token is, from its grammar's scopes; each client picks the colors. */
export const TokenKindSchema = z.enum([
  'comment',
  'string',
  'number',
  'constant',
  'keyword',
  'operator',
  'type',
  'function',
  'variable',
  'property',
  'tag',
  'attribute',
  'heading',
  'link',
]);
export type TokenKind = z.infer<typeof TokenKindSchema>;

/** A token on one line. Columns count UTF-16 units, like a JS string index; `end` is exclusive. Text outside every token is plain. */
export const TokenSchema = z.object({ start: z.number().int(), end: z.number().int(), kind: TokenKindSchema });
export type Token = z.infer<typeof TokenSchema>;

/**
 * `GET /api/highlight` (a `FileQuery`): one side of a file as syntax tokens, read as `/api/file` reads it.
 * Highlighting the whole side keeps multi-line strings and comments right in a hunk.
 */
export const HighlightResponseSchema = z.object({
  path: z.string(),
  /** The grammar's name, e.g. `Rust`. Null when none matched or the side is binary or too large to highlight; `lines` is empty then. */
  language: z.string().nullable(),
  /** Tokens per line, first line first. Highlighting stops at a time limit, so a long side may have fewer entries than lines: the rest are plain. */
  lines: TokenSchema.array().array(),
});
export type HighlightResponse = z.infer<typeof HighlightResponseSchema>;
/** `POST /api/blame`: who last changed lines of one side of a file, read through the allowlist `/api/file` reads. */
export const BlameRequestSchema = z.object({
  path: z.string().min(1),
  side: SideSchema,
  /** 1-based first line to blame; the whole side when absent. */
  start: z.number().int().positive().optional(),
  /** 1-based last line, inclusive; `start` alone blames that one line. */
  end: z.number().int().positive().optional(),
});
export type BlameRequest = z.infer<typeof BlameRequestSchema>;

/** A commit that last changed some blamed lines. */
export const BlameCommitSchema = z.object({
  sha: z.string(),
  short: z.string(),
  author: z.string(),
  /** Author time, in seconds since the epoch. */
  time: z.number().int(),
  /** The message's first line. */
  summary: z.string(),
});
export type BlameCommit = z.infer<typeof BlameCommitSchema>;

/** Consecutive lines one commit last changed. */
export const BlameHunkSchema = z.object({
  /** 1-based first line on the blamed side. */
  start: z.number().int().positive(),
  lines: z.number().int().positive(),
  /** A `commits` entry's sha; null for worktree lines no commit holds yet. */
  commit: z.string().nullable(),
});
export type BlameHunk = z.infer<typeof BlameHunkSchema>;

/**
 * A side is blamed at its own commit, so in a range a line the range added names its commit there;
 * the worktree is blamed against HEAD. A side with no history, as an interdiff's replayed old side, is a 404.
 */
export const BlameResponseSchema = z.object({
  path: z.string(),
  side: SideSchema,
  /** In line order, covering the requested lines that exist. */
  hunks: BlameHunkSchema.array(),
  commits: BlameCommitSchema.array(),
});
export type BlameResponse = z.infer<typeof BlameResponseSchema>;

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
/** Who deletes, on `DELETE` of a thread or a message. Absent: the reviewer. */
export const AuthorQuerySchema = z.object({ author: CommentAuthorSchema.optional() });
export type AuthorQuery = z.infer<typeof AuthorQuerySchema>;
export const ClearThreadsQuerySchema = AuthorQuerySchema.extend({ stale: z.literal('1').optional() });
export const PatchQuerySchema = z.object({ path: z.string().optional() });
/**
 * What `GET /api/server` answers, before the first review resolves too: which run is listening, for
 * which repository. A client trusts `<git-dir>/diffle/server.json` only when its `instance` and
 * `gitDir` match this.
 */
export const ServerInfoSchema = z.object({
  /** Minted once per run. */
  instance: z.string(),
  pid: z.number().int(),
  /** The repository's git directory, as the server resolved it. */
  gitDir: z.string(),
  /** The server's semantic version, as `diffle --version` prints it. */
  version: z.string(),
  /** The active review's comparison label, as the run's status line names it; absent until the first review resolves. */
  label: z.string().optional(),
});
export type ServerInfo = z.infer<typeof ServerInfoSchema>;

/**
 * `GET /api/threads/activity`. Without `since`, answers the current state and a fresh cursor at once;
 * with it, waits until a thread or the comment key changed after the cursor, by anyone but `ignore`.
 * Without `timeout`, waits until then or until the server closes.
 */
export const ActivityQuerySchema = z.object({
  /** A `cursor` this server answered earlier. */
  since: z.string().optional(),
  /** An author whose changes do not end the wait; they are still reported once something else does. */
  ignore: CommentAuthorSchema.optional(),
  /** Seconds to wait at most. */
  timeout: z
    .string()
    .regex(/^[0-9]+$/)
    .optional(),
});
export type ActivityQuery = z.infer<typeof ActivityQuerySchema>;

/** What changed in the shown comment set since a cursor. */
export const ActivitySchema = z.object({
  /** `<instance>:<seq>`; the next wait's `since`. */
  cursor: z.string(),
  /** The set `threads` belong to; it switches when the reviewer focuses another slice. */
  commentKey: z.string(),
  /** Threads changed since the cursor, as they are now; after a key switch or a resync, every thread of the set. */
  threads: CommentThreadSchema.array(),
  /** Ids of threads changed since the cursor that no longer exist. */
  removed: z.string().array(),
  /** The cursor came from another run or fell out of the log's window: `threads` is the full set. */
  resync: z.boolean(),
  /** The server is closing; nothing more will come. */
  closed: z.boolean(),
});
export type Activity = z.infer<typeof ActivitySchema>;

export const ApiErrorSchema = z.object({ error: z.string() });
