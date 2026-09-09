import { beforeEach, describe, expect, it } from 'vitest';
import type { CommentThread } from '../../src/shared/protocol.js';
import { buildReview, exportToGithub, formatBody, GithubError, repoOfPrUrl, type GhRunner } from '../../src/server/github.js';

const PR_URL = 'https://github.com/o/r/pull/7';
const PR_VIEW = JSON.stringify({ number: 7, url: PR_URL, headRefOid: 'a'.repeat(40) });

const HEAD = 'a'.repeat(40);

function thread(over: Partial<CommentThread> & { id: string; path?: string; line?: number; endLine?: number; side?: 'old' | 'new'; body?: string }): CommentThread {
  const { path = 'a.txt', line = 3, endLine = line, side = 'new', body = 'hi', ...rest } = over;
  return {
    anchor: { path, side, startLine: line, endLine, quoted: 'x' },
    messages: [{ id: `${rest.id}-m`, body, createdAt: 1, updatedAt: 1 }],
    resolved: false,
    stale: false,
    ...rest,
  };
}

describe('buildReview', () => {
  it('maps sides and multi-line ranges to the REST review shape', () => {
    const { review, skipped } = buildReview([thread({ id: 'n', line: 3 }), thread({ id: 'o', side: 'old', line: 5, endLine: 8, body: 'gone' })], HEAD);
    expect(skipped).toEqual([]);
    expect(review.commit_id).toBe(HEAD);
    // No `event`: the review GitHub creates from this stays pending.
    expect(review).not.toHaveProperty('event');
    expect(review.comments).toEqual([
      { path: 'a.txt', line: 3, side: 'RIGHT', body: 'hi' },
      { path: 'a.txt', line: 8, side: 'LEFT', start_line: 5, start_side: 'LEFT', body: 'gone' },
    ]);
  });

  it('skips stale threads and, without ids, resolved ones', () => {
    const { review, skipped } = buildReview([thread({ id: 's', stale: true }), thread({ id: 'r', resolved: true }), thread({ id: 'k' })], HEAD);
    expect(review.comments.map((c) => c.body)).toEqual(['hi']);
    expect(skipped).toEqual([{ id: 's', reason: 'stale' }]);
  });

  it('with ids posts the named threads, resolved included, and reports unknown ids', () => {
    const { review, skipped } = buildReview([thread({ id: 'r', resolved: true, body: 'done' }), thread({ id: 'k' })], HEAD, ['r', 'nope']);
    expect(review.comments.map((c) => c.body)).toEqual(['done']);
    expect(skipped).toEqual([{ id: 'nope', reason: 'unknown thread' }]);
  });
});

describe('formatBody', () => {
  it('joins messages and keeps suggestion fences verbatim', () => {
    const body = formatBody([
      { id: '1', body: 'Batch this.', createdAt: 1, updatedAt: 1 },
      { id: '2', body: '```suggestion\nfoo()\n```', createdAt: 2, updatedAt: 2 },
    ]);
    expect(body).toBe('Batch this.\n\n---\n\n```suggestion\nfoo()\n```');
  });
});

describe('repoOfPrUrl', () => {
  it('takes the base repo from the pull request url, on github.com and elsewhere', () => {
    expect(repoOfPrUrl(PR_URL)).toEqual({ owner: 'o', repo: 'r' });
    expect(repoOfPrUrl('https://ghe.example.com/acme/app/pull/12')).toEqual({ owner: 'acme', repo: 'app' });
    expect(() => repoOfPrUrl('https://github.com/o/r/issues/7')).toThrow(GithubError);
  });
});

describe('exportToGithub', () => {
  const calls: { args: string[]; input?: string }[] = [];
  /** One comment already in the pending review, as a review thread reports it. */
  type Existing = { node_id: string; path: string; side: 'LEFT' | 'RIGHT'; line: number; start_line?: number; body: string };

  /** `reviewThreads` shape: one thread per comment, all of them on the pending review. */
  const threadNodes = (existing: Existing[], reviewId: string) =>
    existing.map((c) => ({
      path: c.path,
      line: c.line,
      startLine: c.start_line ?? c.line,
      diffSide: c.side,
      comments: { nodes: [{ id: c.node_id, body: c.body, pullRequestReview: { id: reviewId } }] },
    }));

  /**
   * `pending`: the id of a pending review the viewer already has, or null for none.
   * `existing`: the comments that review already holds.
   */
  function runner(pending: string | null = null, existing: Existing[] = []): GhRunner {
    return async (args, { input }) => {
      calls.push({ args, input });
      if (args[0] === 'pr') return PR_VIEW;
      if (args[1] !== 'graphql') return '{}';
      const query = (JSON.parse(input!) as { query: string }).query;
      if (query.includes('reviewThreads')) {
        const reviewThreads = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: threadNodes(existing, pending ?? '') };
        return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads } } } });
      }
      if (query.startsWith('query')) {
        const nodes = pending ? [{ id: pending, author: { login: 'me' } }] : [];
        return JSON.stringify({ data: { viewer: { login: 'me' }, repository: { pullRequest: { reviews: { nodes } } } } });
      }
      if (query.includes('updatePullRequestReviewComment')) return JSON.stringify({ data: { updatePullRequestReviewComment: { pullRequestReviewComment: { id: 'c' } } } });
      return JSON.stringify({ data: { addPullRequestReviewThread: { thread: { id: 't' } } } });
    };
  }
  const gh = runner();
  const snap = { root: '/r', newSha: HEAD, headSha: HEAD };

  beforeEach(() => {
    calls.length = 0;
  });

  it('refuses the worktree and a new side that is not HEAD', async () => {
    const threads = [thread({ id: 'k' })];
    await expect(exportToGithub({ snap: { root: '/r', newSha: 'worktree', headSha: HEAD }, threads, run: gh })).rejects.toThrow(GithubError);
    await expect(exportToGithub({ snap: { root: '/r', newSha: 'b'.repeat(40), headSha: HEAD }, threads, run: gh })).rejects.toThrow(/checked-out commit/);
    expect(calls).toEqual([]);
  });

  it('creates a pending review, without an event, when the viewer has none', async () => {
    const res = await exportToGithub({ snap, threads: [thread({ id: 'k' }), thread({ id: 's', stale: true })], run: gh });
    expect(res).toEqual({ url: PR_URL, posted: 1, updated: 0, review: 'created', skipped: [{ id: 's', reason: 'stale' }] });
    expect(calls.map((c) => c.args)).toEqual([
      ['pr', 'view', '--json', 'number,url,headRefOid'],
      ['api', 'graphql', '--input', '-'],
      ['api', '--method', 'POST', 'repos/{owner}/{repo}/pulls/7/reviews', '--input', '-'],
    ]);
    const body = JSON.parse(calls[2]!.input!) as Record<string, unknown>;
    expect(body).toEqual({ commit_id: HEAD, comments: [{ path: 'a.txt', line: 3, side: 'RIGHT', body: 'hi' }] });
  });

  it('adds a thread per comment to the pending review the viewer already has', async () => {
    const res = await exportToGithub({ snap, threads: [thread({ id: 'k' }), thread({ id: 'o', side: 'old', line: 5, endLine: 8, body: 'gone' })], run: runner('PRR_1') });
    expect(res).toEqual({ url: PR_URL, posted: 2, updated: 0, review: 'existing', skipped: [] });
    expect(calls.map((c) => c.args[0])).toEqual(['pr', 'api', 'api', 'api', 'api']);
    // The read of what the pending review already holds comes before any write.
    expect((JSON.parse(calls[2]!.input!) as { query: string }).query).toContain('reviewThreads');
    // No reviews POST and no submit: the pending review is only extended.
    expect(calls.some((c) => c.args.includes('--method'))).toBe(false);
    const inputs = calls.slice(3).map((c) => (JSON.parse(c.input!) as { variables: { input: unknown } }).variables.input);
    expect(inputs).toEqual([
      { pullRequestReviewId: 'PRR_1', path: 'a.txt', line: 3, side: 'RIGHT', body: 'hi' },
      { pullRequestReviewId: 'PRR_1', path: 'a.txt', line: 8, side: 'LEFT', body: 'gone', startLine: 5, startSide: 'LEFT' },
    ]);
  });

  it('leaves an identical comment already in the pending review alone', async () => {
    const existing = [{ node_id: 'C_1', path: 'a.txt', side: 'RIGHT' as const, line: 3, body: 'hi' }];
    const res = await exportToGithub({ snap, threads: [thread({ id: 'k' })], run: runner('PRR_1', existing) });
    expect(res).toEqual({ url: PR_URL, posted: 0, updated: 0, review: 'existing', skipped: [{ id: 'k', reason: 'already in the review' }] });
    // Nothing was written: the list is the last call.
    expect(calls.map((c) => c.args[0])).toEqual(['pr', 'api', 'api']);
  });

  it('rewrites the comment in place when the thread was edited, matching path, side and lines', async () => {
    const existing = [
      { node_id: 'C_1', path: 'a.txt', side: 'RIGHT' as const, line: 3, body: 'stale text' },
      { node_id: 'C_2', path: 'a.txt', side: 'LEFT' as const, line: 8, start_line: 5, body: 'gone' },
    ];
    const threads = [thread({ id: 'k', body: 'hi' }), thread({ id: 'o', side: 'old', line: 5, endLine: 8, body: 'gone' }), thread({ id: 'n', line: 9, body: 'new one' })];
    const res = await exportToGithub({ snap, threads, run: runner('PRR_1', existing) });
    expect(res).toEqual({ url: PR_URL, posted: 1, updated: 1, review: 'existing', skipped: [{ id: 'o', reason: 'already in the review' }] });
    const inputs = calls.slice(3).map((c) => (JSON.parse(c.input!) as { variables: { input: unknown } }).variables.input);
    expect(inputs).toEqual([
      { pullRequestReviewCommentId: 'C_1', body: 'hi' },
      { pullRequestReviewId: 'PRR_1', path: 'a.txt', line: 9, side: 'RIGHT', body: 'new one' },
    ]);
  });

  it('side and lines are part of the identity: a comment on the other side is not a match', async () => {
    const existing = [{ node_id: 'C_1', path: 'a.txt', side: 'LEFT' as const, line: 3, body: 'hi' }];
    const res = await exportToGithub({ snap, threads: [thread({ id: 'k' })], run: runner('PRR_1', existing) });
    expect(res).toMatchObject({ posted: 1, updated: 0, skipped: [] });
  });

  it('two threads on one line become two comments: the matched comment is claimed once', async () => {
    const existing = [{ node_id: 'C_1', path: 'a.txt', side: 'RIGHT' as const, line: 3, body: 'first' }];
    const threads = [thread({ id: 'a', body: 'first' }), thread({ id: 'b', body: 'second' })];
    const res = await exportToGithub({ snap, threads, run: runner('PRR_1', existing) });
    expect(res).toMatchObject({ posted: 1, updated: 0, skipped: [{ id: 'a', reason: 'already in the review' }] });
  });

  it('never rewrites a comment of another review: only the pending review\'s own count', async () => {
    const submitted: GhRunner = async (args, o) => {
      if (args[1] === 'graphql' && (JSON.parse(o.input!) as { query: string }).query.includes('reviewThreads')) {
        calls.push({ args, input: o.input });
        const nodes = threadNodes([{ node_id: 'C_1', path: 'a.txt', side: 'RIGHT', line: 3, body: 'hi' }], 'PRR_OLD');
        return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes } } } } });
      }
      return runner('PRR_1')(args, o);
    };
    const res = await exportToGithub({ snap, threads: [thread({ id: 'k' })], run: submitted });
    expect(res).toMatchObject({ posted: 1, updated: 0, skipped: [] });
  });

  it('adds its comments anyway when the pending review\'s own comments cannot be read', async () => {
    const blind: GhRunner = async (args, o) => {
      if (args[1] === 'graphql' && (JSON.parse(o.input!) as { query: string }).query.includes('reviewThreads')) throw new GithubError('gh api graphql failed: 502', 502);
      return runner('PRR_1')(args, o);
    };
    const res = await exportToGithub({ snap, threads: [thread({ id: 'k' })], run: blind });
    expect(res).toMatchObject({ posted: 1, updated: 0 });
  });

  it('ignores a pending review that is not the viewer\'s own', async () => {
    const others: GhRunner = async (args, o) => {
      if (args[1] === 'graphql' && (JSON.parse(o.input!) as { query: string }).query.startsWith('query')) {
        calls.push({ args, input: o.input });
        return JSON.stringify({ data: { viewer: { login: 'me' }, repository: { pullRequest: { reviews: { nodes: [{ id: 'PRR_2', author: { login: 'someone' } }] } } } } });
      }
      return gh(args, o);
    };
    const res = await exportToGithub({ snap, threads: [thread({ id: 'k' })], run: others });
    expect(res.review).toBe('created');
  });

  it('says how many comments already landed when one of the appends fails', async () => {
    let seen = 0;
    const flaky: GhRunner = async (args, o) => {
      if (args[1] === 'graphql' && !(JSON.parse(o.input!) as { query: string }).query.startsWith('query') && seen++ === 1) {
        throw new GithubError('gh api graphql failed: line outside the diff', 502);
      }
      return runner('PRR_1')(args, o);
    };
    await expect(exportToGithub({ snap, threads: [thread({ id: 'k' }), thread({ id: 'k2', line: 9 })], run: flaky })).rejects.toThrow(/added 1 of 2 comments/);
  });

  it('refuses when the PR head is not the local HEAD, before posting', async () => {
    const behind: GhRunner = async (args, o) => (args[0] === 'pr' ? JSON.stringify({ number: 7, url: PR_URL, headRefOid: 'c'.repeat(40) }) : gh(args, o));
    await expect(exportToGithub({ snap, threads: [thread({ id: 'k' })], run: behind })).rejects.toThrow(/push first/);
    expect(calls).toEqual([]); // `behind` answers `pr view` itself, so nothing reached the api

  });

  it('answers 400 when every thread is skipped', async () => {
    await expect(exportToGithub({ snap, threads: [thread({ id: 's', stale: true })], run: gh })).rejects.toMatchObject({ status: 400, message: /1 stale/ });
  });
});
