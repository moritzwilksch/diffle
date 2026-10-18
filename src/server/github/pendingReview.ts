// GraphQL operations on the viewer's pending review: find it, read its comments, create it, extend it.
import type { GithubPullRequest } from '../../shared/protocol.js';
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

/** The anchor must still match before we rewrite an exported thread. */
export function anchorKey(c: ReviewComment): string {
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
export async function findPendingReview(
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
export async function pendingComments(
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

/** Rewrites one comment where it already sits in the pending review. */
export async function updateComment(github: GithubClient, nodeId: string, body: string): Promise<void> {
  await github.graphql(UPDATE_COMMENT, { input: { pullRequestReviewCommentId: nodeId, body } });
}

const CREATE_REVIEW = `mutation($input:AddPullRequestReviewInput!){addPullRequestReview(input:$input){pullRequestReview{id}}}`;

/**
 * No `event` in the input, so GitHub keeps the new review pending with all of its threads.
 * Resolves the review's node id, for the comments a new review cannot carry.
 */
export async function createPendingReview(
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
export async function addToPendingReview(github: GithubClient, reviewId: string, c: ReviewComment): Promise<void> {
  await github.graphql(ADD_THREAD, { input: { pullRequestReviewId: reviewId, ...c } });
}
