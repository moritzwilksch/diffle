import { execFile } from 'node:child_process';
import type { CommentMessage, CommentThread, GithubExportResponse, Snapshot } from '../shared/protocol.js';
import { compareThreads } from './comments/anchor.js';

/** Runs `gh` with `args` in `cwd` and resolves its stdout. The test seam: nothing here spawns `gh` directly. */
export type GhRunner = (args: string[], opts: { cwd: string; input?: string }) => Promise<string>;

/** A precondition the user can fix (no gh, no PR, wrong mode, unpushed head): the route answers 4xx. */
export class GithubError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 | 502 = 409,
  ) {
    super(message);
  }
}

/** One entry of the REST review payload's `comments[]`. */
export interface ReviewComment {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  start_line?: number;
  start_side?: 'LEFT' | 'RIGHT';
  body: string;
}

/**
 * The REST review payload. `event` is deliberately absent: a review created without
 * one stays PENDING, which is the whole point — the human submits it on github.com.
 */
export interface ReviewPayload {
  commit_id: string;
  comments: ReviewComment[];
}

export interface BuiltReview {
  review: ReviewPayload;
  /** The thread each `review.comments[i]` came from, so a per-comment outcome can name its thread. */
  ids: string[];
  skipped: GithubExportResponse['skipped'];
}

/**
 * Threads → the comments of one pending GitHub review, one per thread. Stale threads are skipped:
 * their lines no longer sit in the diff, and GitHub would refuse them anyway. With
 * `threadIds`, only those (resolved included, the user asked for them by hand);
 * without, every unresolved thread.
 */
export function buildReview(threads: CommentThread[], commitId: string, threadIds?: string[]): BuiltReview {
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
  return { review: { commit_id: commitId, comments }, ids, skipped };
}

function toReviewComment(t: CommentThread): ReviewComment {
  const { anchor } = t;
  const side = anchor.side === 'old' ? 'LEFT' : 'RIGHT';
  const c: ReviewComment = { path: anchor.path, line: anchor.endLine, side, body: formatBody(t.messages) };
  if (anchor.startLine !== anchor.endLine) {
    c.start_line = anchor.startLine;
    c.start_side = side;
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

interface PrInfo {
  number: number;
  url: string;
  headRefOid: string;
}

/** The base repository the pull request lives in, taken from its url (a fork's own remote is not it). */
export function repoOfPrUrl(url: string): { owner: string; repo: string } {
  const m = /^\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(new URL(url).pathname);
  if (!m) throw new GithubError(`cannot read owner/repo from the pull request url: ${url}`, 502);
  return { owner: m[1]!, repo: m[2]! };
}

export interface ExportInput {
  snap: Pick<Snapshot, 'root' | 'newSha' | 'headSha'>;
  threads: CommentThread[];
  threadIds?: string[];
  run?: GhRunner;
}

/**
 * Adds the threads to a *pending* review on the PR of the checked-out branch, creating
 * the pending review when there is none. The review is never submitted: the human opens
 * the PR and submits it themselves. Refuses when the new side is not the checked-out
 * commit: GitHub anchors comments to a commit, and only HEAD is what the PR shows.
 *
 * Re-exporting is idempotent against that pending review: a comment already sitting at the
 * thread's anchor is left alone when its body matches and rewritten when it does not, so
 * editing a thread and exporting again does not stack a second comment on the line. Comments
 * of an already-submitted review are out of reach — those would have to be replied to.
 */
export async function exportToGithub({ snap, threads, threadIds, run = runGh }: ExportInput): Promise<GithubExportResponse> {
  if (snap.newSha === 'worktree') throw new GithubError('GitHub cannot anchor comments to uncommitted lines; commit and review the commit (pr, branch or a revspec ending at HEAD)');
  if (snap.headSha === '' || snap.newSha !== snap.headSha) throw new GithubError('the new side must be the checked-out commit (HEAD) to post to its pull request');
  const { review, ids, skipped } = buildReview(threads, snap.newSha, threadIds);
  if (review.comments.length === 0) throw new GithubError(skipped.length ? `nothing to post: ${describe(skipped)}` : 'nothing to post', 400);

  const pr = parsePr(await run(['pr', 'view', '--json', 'number,url,headRefOid'], { cwd: snap.root }));
  if (pr.headRefOid !== snap.newSha) {
    throw new GithubError(`the pull request head is ${pr.headRefOid.slice(0, 7)} but HEAD is ${snap.newSha.slice(0, 7)}; push first`);
  }

  const pending = await findPendingReview(run, snap.root, pr);
  if (!pending) {
    await createPendingReview(run, snap.root, pr.number, review);
    return { url: pr.url, posted: review.comments.length, updated: 0, review: 'created', skipped };
  }

  // A second export of the same threads must not stack duplicates on the line: an
  // identical comment is left alone, an edited one is rewritten where it already sits.
  const existing = await pendingComments(run, snap.root, pr, pending.databaseId);
  const add: ReviewComment[] = [];
  let updated = 0;
  for (const [i, c] of review.comments.entries()) {
    const id = ids[i]!;
    const key = anchorKey(c);
    const hit = existing.get(key);
    if (!hit) {
      add.push(c);
      continue;
    }
    // One comment per anchor is claimed once, so two threads on the same lines
    // become two comments instead of overwriting each other.
    existing.delete(key);
    if (hit.body.trim() === c.body.trim()) {
      skipped.push({ id, reason: 'already in the review' });
      continue;
    }
    await updateComment(run, snap.root, hit.nodeId, c.body, updated, review.comments.length);
    updated++;
  }
  await addToPendingReview(run, snap.root, pending.id, add);
  return { url: pr.url, posted: add.length, updated, review: 'existing', skipped };
}

/** Where a comment sits in the diff: the identity diffle matches a thread to a comment by. */
function anchorKey(c: Pick<ReviewComment, 'path' | 'side' | 'line' | 'start_line'>): string {
  return [c.path, c.side, c.start_line ?? c.line, c.line].join('\0');
}

const PENDING_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  viewer{login}
  repository(owner:$owner,name:$repo){pullRequest(number:$number){reviews(last:20,states:[PENDING]){nodes{id fullDatabaseId author{login}}}}}
}`;

interface PendingQueryData {
  viewer?: { login?: string };
  repository?: {
    pullRequest?: { reviews?: { nodes?: ({ id?: string; fullDatabaseId?: string | number; author?: { login?: string } | null } | null)[] } };
  };
}

/** The viewer's own pending review: `id` for the GraphQL mutations, `databaseId` for the REST comment list. */
interface PendingReview {
  id: string;
  databaseId: string;
}

/**
 * The viewer's own pending review on the PR, or null. GitHub hides other people's pending
 * reviews, and the login check makes sure of it: appending to someone else's draft would
 * put our comments in their review.
 */
async function findPendingReview(run: GhRunner, cwd: string, pr: PrInfo): Promise<PendingReview | null> {
  const { owner, repo } = repoOfPrUrl(pr.url);
  const data = await graphql<PendingQueryData>(run, cwd, PENDING_QUERY, { owner, repo, number: pr.number });
  const login = data.viewer?.login;
  for (const node of data.repository?.pullRequest?.reviews?.nodes ?? []) {
    if (node?.id && node.author?.login === login) return { id: node.id, databaseId: String(node.fullDatabaseId ?? '') };
  }
  return null;
}

/** One comment already in the pending review: its node id (to rewrite) and body (to compare). */
interface PendingComment {
  nodeId: string;
  body: string;
}

interface RestReviewComment {
  node_id?: string;
  path?: string;
  side?: string;
  line?: number | null;
  original_line?: number | null;
  start_line?: number | null;
  body?: string;
}

/**
 * The pending review's own comments, by anchor. REST is the only view that carries `side`
 * — the GraphQL comment type has no such field — and it lists a pending review's comments
 * for their author. An empty map (unreadable review, no databaseId) just means nothing
 * matches, so the export still adds its comments.
 */
async function pendingComments(run: GhRunner, cwd: string, pr: PrInfo, databaseId: string): Promise<Map<string, PendingComment>> {
  const by = new Map<string, PendingComment>();
  if (!databaseId) return by;
  const { owner, repo } = repoOfPrUrl(pr.url);
  let out: string;
  try {
    out = await run(['api', '--paginate', `repos/${owner}/${repo}/pulls/${pr.number}/reviews/${databaseId}/comments?per_page=100`], { cwd });
  } catch {
    return by;
  }
  let list: RestReviewComment[];
  try {
    list = JSON.parse(out) as RestReviewComment[];
  } catch {
    return by;
  }
  if (!Array.isArray(list)) return by;
  for (const c of list) {
    const line = c.line ?? c.original_line;
    if (!c.node_id || !c.path || line == null) continue;
    const side = c.side === 'LEFT' ? 'LEFT' : 'RIGHT';
    by.set(anchorKey({ path: c.path, side, line, start_line: c.start_line ?? undefined }), { nodeId: c.node_id, body: c.body ?? '' });
  }
  return by;
}

const UPDATE_COMMENT = `mutation($input:UpdatePullRequestReviewCommentInput!){updatePullRequestReviewComment(input:$input){pullRequestReviewComment{id}}}`;

/** Rewrites one pending comment's body in place. `done` is how many changes already landed, for the partial-failure message. */
async function updateComment(run: GhRunner, cwd: string, nodeId: string, body: string, done: number, total: number): Promise<void> {
  try {
    await graphql(run, cwd, UPDATE_COMMENT, { input: { pullRequestReviewCommentId: nodeId, body } });
  } catch (e) {
    if (done === 0) throw e;
    const detail = e instanceof Error ? e.message : String(e);
    throw new GithubError(`changed ${done} of ${total} comments in the pending review, then ${detail}`, 502);
  }
}

/** No `event` in the body, so GitHub keeps the new review pending with all of its comments. */
async function createPendingReview(run: GhRunner, cwd: string, number: number, review: ReviewPayload): Promise<void> {
  await run(['api', '--method', 'POST', `repos/{owner}/{repo}/pulls/${number}/reviews`, '--input', '-'], { cwd, input: JSON.stringify(review) });
}

const ADD_THREAD = `mutation($input:AddPullRequestReviewThreadInput!){addPullRequestReviewThread(input:$input){thread{id}}}`;

/**
 * One thread per comment on an existing pending review: REST can only create a pending
 * review, not extend one. Comments land one request at a time, so a failure part-way
 * says how many are already in the review.
 */
async function addToPendingReview(run: GhRunner, cwd: string, reviewId: string, comments: ReviewComment[]): Promise<void> {
  for (const [i, c] of comments.entries()) {
    const input: Record<string, unknown> = { pullRequestReviewId: reviewId, path: c.path, line: c.line, side: c.side, body: c.body };
    if (c.start_line != null) {
      input.startLine = c.start_line;
      input.startSide = c.start_side;
    }
    try {
      await graphql(run, cwd, ADD_THREAD, { input });
    } catch (e) {
      if (i === 0) throw e;
      const detail = e instanceof Error ? e.message : String(e);
      throw new GithubError(`added ${i} of ${comments.length} comments to the pending review, then ${detail}`, 502);
    }
  }
}

/** Runs a GraphQL document through `gh api graphql` and returns its `data`. */
async function graphql<T>(run: GhRunner, cwd: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const out = await run(['api', 'graphql', '--input', '-'], { cwd, input: JSON.stringify({ query, variables }) });
  let body: { data?: T };
  try {
    body = JSON.parse(out) as { data?: T };
  } catch {
    throw new GithubError(`unexpected output from gh api graphql: ${out.slice(0, 200)}`, 502);
  }
  if (body.data == null) throw new GithubError(`unexpected output from gh api graphql: ${out.slice(0, 200)}`, 502);
  return body.data;
}

function describe(skipped: GithubExportResponse['skipped']): string {
  const counts = new Map<string, number>();
  for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  return [...counts].map(([reason, n]) => `${n} ${reason}`).join(', ');
}

function parsePr(out: string): PrInfo {
  let pr: Partial<PrInfo>;
  try {
    pr = JSON.parse(out) as Partial<PrInfo>;
  } catch {
    throw new GithubError(`unexpected output from gh pr view: ${out.slice(0, 200)}`, 502);
  }
  if (typeof pr.number !== 'number' || typeof pr.url !== 'string' || typeof pr.headRefOid !== 'string') {
    throw new GithubError(`unexpected output from gh pr view: ${out.slice(0, 200)}`, 502);
  }
  return pr as PrInfo;
}

/** Spawns the local `gh`. A missing binary or a failing command becomes a GithubError carrying gh's own message. */
export const runGh: GhRunner = (args, { cwd, input }) =>
  new Promise((resolve, reject) => {
    const child = execFile('gh', args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new GithubError('gh is not installed; see https://cli.github.com'));
      const detail = (stderr || err.message).trim().split('\n')[0] ?? '';
      // `gh api` failures are GitHub's answer (422 on a line outside the diff, 404 on a missing PR); the rest is local setup.
      reject(new GithubError(`gh ${args[0]} ${args[1] ?? ''} failed: ${detail}`.trim(), args[0] === 'api' ? 502 : 409));
    });
    if (input != null) child.stdin?.end(input);
    else child.stdin?.end();
  });
