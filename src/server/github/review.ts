import type {
  CommentMessage,
  CommentThread,
  GithubExportResponse,
  GithubPullRequest,
  Snapshot,
} from '@/shared/protocol.js';
import { compareThreads } from '@/server/comments/anchor.js';
import { type GithubClient, GithubError } from './client.js';
import {
  addToPendingReview,
  anchorKey,
  createPendingReview,
  findPendingReview,
  isFileComment,
  type LineReviewComment,
  pendingComments,
  type ReviewComment,
  updateComment,
} from './pendingReview.js';

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
      await updateComment(github, hit.nodeId, c.body);
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

function describe(skipped: GithubExportResponse['skipped']): string {
  const counts = new Map<string, number>();
  for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  return [...counts].map(([reason, n]) => `${n} ${reason}`).join(', ');
}
