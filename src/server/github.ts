import { execFile } from 'node:child_process';
import type {
  CommentMessage,
  CommentThread,
  GithubExportResponse,
  GithubPullRequest,
  Snapshot,
} from '../shared/protocol.js';
import { compareThreads } from './comments/anchor.js';

/** Runs `gh` with `args` in `cwd` and resolves its stdout. The test seam: nothing here spawns `gh` directly. */
export type GhRunner = (args: string[], opts: { cwd: string; input?: string; timeoutMs?: number }) => Promise<string>;

/** A precondition the user can fix (no gh, no PR, wrong mode, unpushed head): the route answers 4xx. */
export class GithubError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 | 502 = 409,
  ) {
    super(message);
  }
}

/** A review comment on a line range, as the REST review payload's `comments[]` takes it. */
export interface LineReviewComment {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  start_line?: number;
  start_side?: 'LEFT' | 'RIGHT';
  body: string;
}

/**
 * A review comment on a file as a whole. REST's review payload has no place for it,
 * so it always reaches the pending review through GraphQL (`subjectType: FILE`).
 */
export interface FileReviewComment {
  path: string;
  subject_type: 'file';
  body: string;
}

export type ReviewComment = LineReviewComment | FileReviewComment;

export function isFileComment(c: ReviewComment): c is FileReviewComment {
  return 'subject_type' in c;
}

/**
 * The REST review payload. `event` is deliberately absent: a review created without
 * one stays PENDING, which is the whole point — the human submits it on github.com.
 */
export interface ReviewPayload {
  commit_id: string;
  comments: LineReviewComment[];
}

export interface BuiltReview {
  review: ReviewPayload;
  /** Every comment to post, line and file alike, in review order. */
  comments: ReviewComment[];
  /** The thread each `comments[i]` came from, so a per-comment outcome can name its thread. */
  ids: string[];
  skipped: GithubExportResponse['skipped'];
}

/**
 * Threads → the comments of one pending GitHub review, one per thread. Stale threads are skipped:
 * their lines no longer sit in the diff, and GitHub would refuse them anyway. So are threads on
 * files outside `changed`, the paths of the PR's diff: GitHub accepts a review comment on an
 * unchanged file but never shows it, so the reviewer would lose it. With `threadIds`, only
 * those (resolved included, the user asked for them by hand); without, every unresolved thread.
 * `review.comments` holds the line comments REST can create; the file comments are appended
 * afterwards, but `ids` counts both, in review order.
 */
export function buildReview(
  threads: CommentThread[],
  commitId: string,
  changed: ReadonlySet<string>,
  threadIds?: string[],
): BuiltReview {
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
    if (!changed.has(t.anchor.path)) {
      skipped.push({ id: t.id, reason: 'outside the diff' });
      continue;
    }
    comments.push(toReviewComment(t));
    ids.push(t.id);
  }
  const lines = comments.filter((c): c is LineReviewComment => !isFileComment(c));
  return { review: { commit_id: commitId, comments: lines }, comments, ids, skipped };
}

function toReviewComment(t: CommentThread): ReviewComment {
  const { anchor } = t;
  const body = formatBody(t.messages);
  if (anchor.kind === 'file') return { path: anchor.path, subject_type: 'file', body };
  const side = anchor.side === 'old' ? 'LEFT' : 'RIGHT';
  const c: LineReviewComment = { path: anchor.path, line: anchor.endLine, side, body };
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

/** The base repository the pull request lives in, taken from its url (a fork's own remote is not it). */
export function repoOfPrUrl(url: string): { owner: string; repo: string } {
  const m = /^\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(new URL(url).pathname);
  if (!m) throw new GithubError(`cannot read owner/repo from the pull request url: ${url}`, 502);
  return { owner: m[1]!, repo: m[2]! };
}

export interface ExportInput {
  snap: Pick<Snapshot, 'root' | 'newSha' | 'changed'>;
  pullRequest: GithubPullRequest;
  threads: CommentThread[];
  threadIds?: string[];
  run?: GhRunner;
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
  run = runGh,
}: ExportInput): Promise<GithubExportResponse> {
  if (snap.newSha === 'worktree') throw new GithubError('GitHub cannot anchor comments to the worktree');
  const changed = new Set(snap.changed.map((f) => f.path));
  const { review, comments, ids, skipped } = buildReview(threads, snap.newSha, changed, threadIds);
  if (comments.length === 0)
    throw new GithubError(skipped.length ? `nothing to post: ${describe(skipped)}` : 'nothing to post', 400);

  for (const [i, comment] of comments.entries()) {
    comment.body += `\n\n${threadMarker(ids[i]!)}`;
  }
  const pending = await findPendingReview(run, snap.root, pr);
  if (!pending) {
    // REST creates the review with the line comments in one call; file comments only exist in GraphQL.
    const created = await createPendingReview(run, snap.root, pr.repository, pr.number, review);
    let appended = 0;
    try {
      for (const c of comments.filter(isFileComment)) {
        await addToPendingReview(run, snap.root, created.id, c);
        appended++;
      }
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      throw new GithubError(
        `created the pending review with ${review.comments.length + appended} comments, then ${detail}`,
        502,
      );
    }
    return { url: pr.url, posted: comments.length, updated: 0, review: 'created', skipped };
  }

  // A second export of the same threads must not stack duplicates on the line: an
  // identical comment is left alone, an edited one is rewritten where it already sits.
  const existing = await pendingComments(run, snap.root, pr, pending.id);
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
      await graphql(run, snap.root, UPDATE_COMMENT, {
        input: { pullRequestReviewCommentId: hit.nodeId, body: c.body },
      });
      updated++;
    }
    for (const c of add) {
      await addToPendingReview(run, snap.root, pending.id, c);
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
  return [c.path, c.side, c.start_line ?? c.line, c.line].join('\0');
}

const PENDING_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  viewer{login}
  repository(owner:$owner,name:$repo){pullRequest(number:$number){reviews(last:20,states:[PENDING]){nodes{id author{login}}}}}
}`;

interface PendingQueryData {
  viewer?: { login?: string };
  repository?: {
    pullRequest?: { reviews?: { nodes?: ({ id?: string; author?: { login?: string } | null } | null)[] } };
  };
}

/**
 * The viewer's own pending review on the PR, or null. GitHub hides other people's pending
 * reviews, and the login check makes sure of it: appending to someone else's draft would
 * put our comments in their review.
 */
async function findPendingReview(run: GhRunner, cwd: string, pr: GithubPullRequest): Promise<{ id: string } | null> {
  const { owner, repo } = repoOfPrUrl(pr.url);
  const data = await graphql<PendingQueryData>(run, cwd, PENDING_QUERY, { owner, repo, number: pr.number });
  const login = data.viewer?.login;
  for (const node of data.repository?.pullRequest?.reviews?.nodes ?? []) {
    if (node?.id && node.author?.login === login) return { id: node.id };
  }
  return null;
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
  run: GhRunner,
  cwd: string,
  pr: GithubPullRequest,
  reviewId: string,
): Promise<Map<string, PendingComment[]>> {
  const by = new Map<string, PendingComment[]>();
  const { owner, repo } = repoOfPrUrl(pr.url);
  let after: string | null = null;
  // Bound API work, but never use a partial map to decide which comments to add.
  for (let page = 0; page < 10; page++) {
    const data: ThreadsQueryData = await graphql<ThreadsQueryData>(run, cwd, THREADS_QUERY, {
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
  if (t.subjectType === 'FILE') return anchorKey({ path, subject_type: 'file', body: '' });
  if (t.line == null) return null;
  const side = t.diffSide === 'LEFT' ? 'LEFT' : 'RIGHT';
  return anchorKey({ path, side, line: t.line, start_line: t.startLine ?? undefined, body: '' });
}

const UPDATE_COMMENT = `mutation($input:UpdatePullRequestReviewCommentInput!){updatePullRequestReviewComment(input:$input){pullRequestReviewComment{id}}}`;

/**
 * No `event` in the body, so GitHub keeps the new review pending with all of its comments.
 * Resolves the review's node id, for the comments REST cannot carry.
 */
async function createPendingReview(
  run: GhRunner,
  cwd: string,
  repository: string,
  number: number,
  review: ReviewPayload,
): Promise<{ id: string }> {
  const out = await run(['api', '--method', 'POST', `repos/${repository}/pulls/${number}/reviews`, '--input', '-'], {
    cwd,
    input: JSON.stringify(review),
  });
  let id: unknown;
  try {
    id = (JSON.parse(out) as { node_id?: unknown }).node_id;
  } catch {
    throw new GithubError(`unexpected output from gh api: ${out.slice(0, 200)}`, 502);
  }
  if (typeof id !== 'string') throw new GithubError(`unexpected output from gh api: ${out.slice(0, 200)}`, 502);
  return { id };
}

const ADD_THREAD = `mutation($input:AddPullRequestReviewThreadInput!){addPullRequestReviewThread(input:$input){thread{id}}}`;

/** Appends one thread through GraphQL; REST cannot extend a pending review, nor place a file comment. */
async function addToPendingReview(run: GhRunner, cwd: string, reviewId: string, c: ReviewComment): Promise<void> {
  const input: Record<string, unknown> = { pullRequestReviewId: reviewId, path: c.path, body: c.body };
  if (isFileComment(c)) {
    input.subjectType = 'FILE';
  } else {
    input.line = c.line;
    input.side = c.side;
    if (c.start_line != null) {
      input.startLine = c.start_line;
      input.startSide = c.start_side;
    }
  }
  await graphql(run, cwd, ADD_THREAD, { input });
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

/** Spawns the local `gh`. A missing binary or a failing command becomes a GithubError carrying gh's own message. */
export const runGh: GhRunner = (args, { cwd, input, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      'gh',
      args,
      { cwd, maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        if ((err as NodeJS.ErrnoException).code === 'ENOENT')
          return reject(new GithubError('gh is not installed; see https://cli.github.com'));
        const detail = (stderr || err.message).trim().split('\n')[0] ?? '';
        // `gh api` failures are GitHub's answer (422 on a line outside the diff, 404 on a missing PR); the rest is local setup.
        reject(
          new GithubError(`gh ${args[0]} ${args[1] ?? ''} failed: ${detail}`.trim(), args[0] === 'api' ? 502 : 409),
        );
      },
    );
    if (input != null) child.stdin?.end(input);
    else child.stdin?.end();
  });

/** A pull request as `gh pr view` reports it, plus the base repository derived from its URL. */
export interface PullRequest extends GithubPullRequest {
  baseRefOid: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  /** Source repository; null when GitHub no longer exposes the deleted fork. */
  headRepository: string | null;
}

const PR_FIELDS =
  'number,url,title,state,isDraft,baseRefOid,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner';

/**
 * `gh pr view` for a PR named by number, `#number`, URL or branch. Without a
 * selector, the PR of the checked-out branch. Option-shaped selectors are
 * refused so a stray flag never reaches gh.
 */
export async function viewPr(
  selector: string | undefined,
  cwd: string,
  run: GhRunner = runGh,
  timeoutMs?: number,
): Promise<PullRequest> {
  const arg = selector == null ? [] : [normalizeSelector(selector)];
  const out = await run(['pr', 'view', ...arg, '--json', PR_FIELDS], { cwd, timeoutMs });
  return parsePullRequest(parseJson(out, 'view'));
}

/** Open pull requests whose head is the named branch in the named remote repository. */
export async function listPrsForHead(
  baseRepo: string,
  base: string,
  head: string,
  headRepo: string,
  cwd: string,
  run: GhRunner = runGh,
  timeoutMs?: number,
): Promise<PullRequest[]> {
  const out = await run(
    [
      'pr',
      'list',
      '--repo',
      baseRepo,
      '--base',
      base,
      '--head',
      head,
      '--state',
      'open',
      '--limit',
      '100',
      '--json',
      PR_FIELDS,
    ],
    {
      cwd,
      timeoutMs,
    },
  );
  const values = parseJson(out, 'list');
  if (!Array.isArray(values)) throw new GithubError(`unexpected output from gh pr list: ${out.slice(0, 200)}`, 502);
  return values.flatMap((value) => {
    const candidate = value as {
      headRepository?: { name?: unknown };
      headRepositoryOwner?: { login?: unknown };
    };
    const owner = candidate?.headRepositoryOwner?.login;
    const name = candidate?.headRepository?.name;
    if (typeof owner !== 'string' || typeof name !== 'string')
      throw new GithubError(`unexpected output from gh pr list: ${out.slice(0, 200)}`, 502);
    if (`${owner}/${name}`.toLowerCase() !== headRepo.toLowerCase()) return [];
    return [parsePullRequest(value)];
  });
}

function normalizeSelector(selector: string): string {
  const s = selector.trim();
  if (s.startsWith('-')) throw new GithubError(`not a pull request: ${selector}`, 400);
  const num = /^#?(\d+)$/.exec(s);
  return num ? num[1]! : s;
}

function parseJson(out: string, command: string): unknown {
  try {
    return JSON.parse(out);
  } catch {
    throw new GithubError(`unexpected output from gh pr ${command}: ${out.slice(0, 200)}`, 502);
  }
}

function parsePullRequest(value: unknown): PullRequest {
  const pr = value as Partial<PullRequest>;
  const ok =
    pr != null &&
    typeof pr.title === 'string' &&
    ['OPEN', 'CLOSED', 'MERGED'].includes(pr.state ?? '') &&
    typeof pr.isDraft === 'boolean' &&
    typeof pr.baseRefOid === 'string' &&
    typeof pr.number === 'number' &&
    typeof pr.url === 'string' &&
    typeof pr.baseRefName === 'string' &&
    typeof pr.headRefName === 'string' &&
    typeof pr.headRefOid === 'string';
  if (!ok) throw new GithubError('unexpected pull request data from gh', 502);
  const slug = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/.exec(pr.url!);
  if (!slug) throw new GithubError(`cannot read the repository from the pull request url: ${pr.url}`, 502);
  const source = value as {
    headRepository?: { name?: string } | null;
    headRepositoryOwner?: { login?: string } | null;
  };
  const owner = source.headRepositoryOwner?.login;
  const name = source.headRepository?.name;
  return {
    headRepository: typeof owner === 'string' && typeof name === 'string' ? `${owner}/${name}` : null,
    number: pr.number!,
    url: pr.url!,
    title: pr.title!,
    state: pr.state!,
    isDraft: pr.isDraft!,
    repository: slug[1]!,
    baseRefOid: pr.baseRefOid!,
    baseRefName: pr.baseRefName!,
    headRefName: pr.headRefName!,
    headRefOid: pr.headRefOid!,
  };
}
