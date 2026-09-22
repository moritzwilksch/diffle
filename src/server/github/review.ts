import type {
  CommentMessage,
  CommentThread,
  GithubExportResponse,
  GithubPullRequest,
  Snapshot,
} from '../../shared/protocol.js';
import { compareThreads } from '../comments/anchor.js';
import { type GithubClient, GithubError } from './client.js';
import { repoOfPrUrl } from './pulls.js';

/** A review comment on a line range, shaped as GraphQL's `DraftPullRequestReviewThread`. */
export interface LineReviewComment {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  startLine?: number;
  startSide?: 'LEFT' | 'RIGHT';
  body: string;
}

/**
 * A review comment on a file as a whole. A review cannot be created with one, so it always
 * reaches the pending review through `addPullRequestReviewThread` (`subjectType: FILE`).
 */
export interface FileReviewComment {
  path: string;
  subjectType: 'FILE';
  body: string;
}

export type ReviewComment = LineReviewComment | FileReviewComment;

export function isFileComment(c: ReviewComment): c is FileReviewComment {
  return 'subjectType' in c;
}

export interface BuiltReview {
  /** Every comment to post, line and file alike, in review order. */
  comments: ReviewComment[];
  /** The thread each `comments[i]` came from, so a per-comment outcome can name its thread. */
  ids: string[];
  skipped: GithubExportResponse['skipped'];
}

/**
 * Threads → the comments of one pending GitHub review, one per thread. Stale threads are skipped:
 * their lines no longer sit in the diff, and GitHub would refuse them anyway. With
 * `threadIds`, only those (resolved included, the user asked for them by hand);
 * without, every unresolved thread.
 */
export function buildReview(threads: CommentThread[], threadIds?: string[]): BuiltReview {
  const skipped: BuiltReview['skipped'] = [];
  let chosen: CommentThread[];
  if (threadIds) {
    const byId = new Map(threads.map((t) => [t.id, t]));
    chosen = [];
    for (const id of threadIds) {
      const t = byId.get(id);
      if (t) chosen.push(t);
      else skipped.push({ id, reason: 'unknown thread' });
    }
  } else {
    chosen = threads.filter((t) => !t.resolved);
  }
  const comments: ReviewComment[] = [];
  const ids: string[] = [];
  for (const t of [...chosen].sort(compareThreads)) {
    if (t.stale) {
      skipped.push({ id: t.id, reason: 'stale' });
      continue;
    }
    comments.push(toReviewComment(t));
    ids.push(t.id);
  }
  return { comments, ids, skipped };
}

function toReviewComment(t: CommentThread): ReviewComment {
  const { anchor } = t;
  const body = formatBody(t.messages);
  if (anchor.kind === 'file') return { path: anchor.path, subjectType: 'FILE', body };
  const side = anchor.side === 'old' ? 'LEFT' : 'RIGHT';
  const c: LineReviewComment = { path: anchor.path, line: anchor.endLine, side, body };
  if (anchor.startLine !== anchor.endLine) {
    c.startLine = anchor.startLine;
    c.startSide = side;
  }
  return c;
}

/**
 * Messages joined as markdown. GitHub renders ```suggestion fences itself, so bodies
 * stay verbatim.
 */
export function formatBody(messages: CommentMessage[]): string {
  return messages.map((m) => m.body.trim()).join('\n\n---\n\n');
}

export interface ExportInput {
  snap: Pick<Snapshot, 'newSha'>;
  pullRequest: GithubPullRequest;
  threads: CommentThread[];
  threadIds?: string[];
  github: GithubClient;
}

/** Serializes validation and writes so overlapping exports cannot add the same thread twice. */
export class GithubExporter {
  private queue: Promise<unknown> = Promise.resolve();

  export(prepare: () => Promise<ExportInput>): Promise<GithubExportResponse> {
    const result = this.queue.then(async () => exportToGithub(await prepare()));
    this.queue = result.catch(() => {});
    return result;
  }
}

/**
 * Adds the threads to a *pending* review on the active PR, creating the pending review
 * when there is none. The review is never submitted: the human opens the PR and submits
 * it themselves. The caller validates the comparison inside the export queue before posting.
 *
 * Re-exporting matches a hidden thread ID and its anchor in the pending review.
 * A matching comment is left alone when its body matches and rewritten when it does not, so
 * editing a thread and exporting again does not stack a second comment on the line. Comments
 * of an already-submitted review are out of reach — those would have to be replied to.
 */
async function exportToGithub({
  snap,
  pullRequest: pr,
  threads,
  threadIds,
  github,
}: ExportInput): Promise<GithubExportResponse> {
  if (snap.newSha === 'worktree') throw new GithubError('GitHub cannot anchor comments to the worktree');
  const { comments, ids, skipped } = buildReview(threads, threadIds);
  if (comments.length === 0)
    throw new GithubError(skipped.length ? `nothing to post: ${describe(skipped)}` : 'nothing to post', 400);

  for (const [i, comment] of comments.entries()) {
    comment.body += `\n\n${threadMarker(ids[i]!)}`;
  }
  const { pullRequestId, pending } = await findPendingReview(github, pr);
  if (!pending) {
    // The review is created with its line comments in one call; file comments only exist as added threads.
    const lines = comments.filter((c): c is LineReviewComment => !isFileComment(c));
    const created = await createPendingReview(github, pullRequestId, snap.newSha, lines);
    let appended = 0;
    try {
      for (const c of comments.filter(isFileComment)) {
        await addToPendingReview(github, created.id, c);
        appended++;
      }
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      throw new GithubError(`created the pending review with ${lines.length + appended} comments, then ${detail}`, 502);
    }
    return { url: pr.url, posted: comments.length, updated: 0, review: 'created', skipped };
  }

  // A second export of the same threads must not stack duplicates on the line: an
  // identical comment is left alone, an edited one is rewritten where it already sits.
  const existing = await pendingComments(github, pr, pending.id);
  const add: ReviewComment[] = [];
  let updated = 0;
  let posted = 0;
  try {
    for (const [i, c] of comments.entries()) {
      const id = ids[i]!;
      // An anchor alone cannot distinguish our thread from another draft on the same lines.
      const at = existing.get(anchorKey(c));
      const index = at?.findIndex((comment) => comment.body.trimEnd().endsWith(threadMarker(id))) ?? -1;
      const hit = index < 0 ? undefined : at!.splice(index, 1)[0];
      if (!hit) {
        add.push(c);
        continue;
      }
      if (hit.body.trim() === c.body.trim()) {
        skipped.push({ id, reason: 'already in the review' });
        continue;
      }
      await github.graphql(UPDATE_COMMENT, {
        input: { pullRequestReviewCommentId: hit.nodeId, body: c.body },
      });
      updated++;
    }
    for (const c of add) {
      await addToPendingReview(github, pending.id, c);
      posted++;
    }
  } catch (e) {
    if (updated === 0 && posted === 0) throw e;
    const detail = e instanceof Error ? e.message : String(e);
    throw new GithubError(`updated ${updated} and added ${posted} comments in the pending review, then ${detail}`, 502);
  }
  return { url: pr.url, posted, updated, review: 'existing', skipped };
}

function threadMarker(id: string): string {
  return `<!-- diffle-thread:${encodeURIComponent(id)} -->`;
}

/** The anchor must still match before we rewrite an exported thread. */
function anchorKey(c: ReviewComment): string {
  if (isFileComment(c)) return [c.path, 'FILE'].join('\0');
  return [c.path, c.side, c.startLine ?? c.line, c.line].join('\0');
}

const PENDING_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  viewer{login}
  repository(owner:$owner,name:$repo){pullRequest(number:$number){id reviews(last:20,states:[PENDING]){nodes{id author{login}}}}}
}`;

interface PendingQueryData {
  viewer?: { login?: string };
  repository?: {
    pullRequest?: {
      id?: string;
      reviews?: { nodes?: ({ id?: string; author?: { login?: string } | null } | null)[] };
    } | null;
  };
}

/**
 * The PR's node id and the viewer's own pending review on it, or null. GitHub hides other
 * people's pending reviews, and the login check makes sure of it: appending to someone
 * else's draft would put our comments in their review.
 */
async function findPendingReview(
  github: GithubClient,
  pr: GithubPullRequest,
): Promise<{ pullRequestId: string; pending: { id: string } | null }> {
  const { owner, repo } = repoOfPrUrl(pr.url);
  const data = await github.graphql<PendingQueryData>(PENDING_QUERY, { owner, repo, number: pr.number });
  const pullRequestId = data.repository?.pullRequest?.id;
  if (typeof pullRequestId !== 'string') throw new GithubError(`cannot read pull request ${pr.url} from GitHub`, 502);
  const login = data.viewer?.login;
  for (const node of data.repository?.pullRequest?.reviews?.nodes ?? []) {
    if (node?.id && node.author?.login === login) return { pullRequestId, pending: { id: node.id } };
  }
  return { pullRequestId, pending: null };
}

/** One comment already in the pending review: its node id (to rewrite) and body (to compare). */
interface PendingComment {
  nodeId: string;
  body: string;
}

const THREADS_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100,after:$after){
    pageInfo{hasNextPage endCursor}
    nodes{path line startLine diffSide subjectType comments(first:1){nodes{id body pullRequestReview{id}}}}
  }}}
}`;

interface ThreadNode {
  path?: string;
  line?: number | null;
  startLine?: number | null;
  diffSide?: string | null;
  /** `FILE` for a comment on the whole file, whose `line` is null. */
  subjectType?: string | null;
  comments?: { nodes?: ({ id?: string; body?: string; pullRequestReview?: { id?: string } | null } | null)[] };
}

interface ThreadsQueryData {
  repository?: {
    pullRequest?: {
      reviewThreads?: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        nodes?: (ThreadNode | null)[];
      };
    };
  };
}

/**
 * The pending review's own comments, by anchor. It has to be `reviewThreads`: it is the only view
 * that reports a *pending* comment's real position — REST's review-comment list leaves `line`,
 * `side` and `start_line` null for one, and the GraphQL comment type has no side field at all.
 * A failed or incomplete lookup aborts the export: absence is safe to infer only from a complete read.
 */
async function pendingComments(
  github: GithubClient,
  pr: GithubPullRequest,
  reviewId: string,
): Promise<Map<string, PendingComment[]>> {
  const by = new Map<string, PendingComment[]>();
  const { owner, repo } = repoOfPrUrl(pr.url);
  let after: string | null = null;
  // Bound API work, but never use a partial map to decide which comments to add.
  for (let page = 0; page < 10; page++) {
    const data: ThreadsQueryData = await github.graphql<ThreadsQueryData>(THREADS_QUERY, {
      owner,
      repo,
      number: pr.number,
      after,
    });
    const threads = data.repository?.pullRequest?.reviewThreads;
    if (!threads?.nodes || typeof threads.pageInfo?.hasNextPage !== 'boolean') {
      throw new GithubError('cannot read the complete pending review', 502);
    }
    for (const t of threads.nodes) {
      const c = t?.comments?.nodes?.[0];
      // Only this pending review's own comments: a submitted comment must not be rewritten.
      if (!t?.path || !c?.id || c.pullRequestReview?.id !== reviewId) continue;
      const key = pendingKey(t);
      if (key == null) continue;
      const at = by.get(key);
      if (at) at.push({ nodeId: c.id, body: c.body ?? '' });
      else by.set(key, [{ nodeId: c.id, body: c.body ?? '' }]);
    }
    if (!threads.pageInfo.hasNextPage) return by;
    if (!threads.pageInfo.endCursor || threads.pageInfo.endCursor === after) {
      throw new GithubError('cannot read the next page of the pending review', 502);
    }
    after = threads.pageInfo.endCursor;
  }
  throw new GithubError('pending review exceeds the 1000-thread lookup limit; export stopped without changes', 502);
}

/** The anchor key of a thread already in the review, or null for one GitHub reports without a position. */
function pendingKey(t: ThreadNode): string | null {
  const path = t.path!;
  if (t.subjectType === 'FILE') return anchorKey({ path, subjectType: 'FILE', body: '' });
  if (t.line == null) return null;
  const side = t.diffSide === 'LEFT' ? 'LEFT' : 'RIGHT';
  return anchorKey({ path, side, line: t.line, startLine: t.startLine ?? undefined, body: '' });
}

const UPDATE_COMMENT = `mutation($input:UpdatePullRequestReviewCommentInput!){updatePullRequestReviewComment(input:$input){pullRequestReviewComment{id}}}`;

const CREATE_REVIEW = `mutation($input:AddPullRequestReviewInput!){addPullRequestReview(input:$input){pullRequestReview{id}}}`;

/**
 * No `event` in the input, so GitHub keeps the new review pending with all of its threads.
 * Resolves the review's node id, for the comments a new review cannot carry.
 */
async function createPendingReview(
  github: GithubClient,
  pullRequestId: string,
  commitOID: string,
  threads: LineReviewComment[],
): Promise<{ id: string }> {
  const data = await github.graphql<{ addPullRequestReview?: { pullRequestReview?: { id?: unknown } | null } }>(
    CREATE_REVIEW,
    { input: { pullRequestId, commitOID, threads } },
  );
  const id = data.addPullRequestReview?.pullRequestReview?.id;
  if (typeof id !== 'string') throw new GithubError('GitHub did not return the created review', 502);
  return { id };
}

const ADD_THREAD = `mutation($input:AddPullRequestReviewThreadInput!){addPullRequestReviewThread(input:$input){thread{id}}}`;

/** Appends one thread to the pending review; the only way to extend one, or to place a file comment. */
async function addToPendingReview(github: GithubClient, reviewId: string, c: ReviewComment): Promise<void> {
  await github.graphql(ADD_THREAD, { input: { pullRequestReviewId: reviewId, ...c } });
}

function describe(skipped: GithubExportResponse['skipped']): string {
  const counts = new Map<string, number>();
  for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  return [...counts].map(([reason, n]) => `${n} ${reason}`).join(', ');
}
