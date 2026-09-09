import { beforeEach, describe, expect, it } from 'vitest';
import type { CommentThread } from '../../src/shared/protocol.js';
import { buildReview, GithubExporter, formatBody, GithubError, repoOfPrUrl, type GhRunner } from '../../src/server/github.js';

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

describe('GithubExporter', () => {
  let exporter: GithubExporter;
  const exportToGithub = (input: Parameters<GithubExporter['export']>[0]) => exporter.export(input);
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
    exporter = new GithubExporter();
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
    expect(body).toEqual({ commit_id: HEAD, comments: [{ path: 'a.txt', line: 3, side: 'RIGHT', body: 'hi\n\n<!-- diffle-thread:k -->' }] });
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
      { pullRequestReviewId: 'PRR_1', path: 'a.txt', line: 3, side: 'RIGHT', body: 'hi\n\n<!-- diffle-thread:k -->' },
      { pullRequestReviewId: 'PRR_1', path: 'a.txt', line: 8, side: 'LEFT', body: 'gone\n\n<!-- diffle-thread:o -->', startLine: 5, startSide: 'LEFT' },
    ]);
  });

  it('leaves an identical comment already in the pending review alone', async () => {
    const existing = [{ node_id: 'C_1', path: 'a.txt', side: 'RIGHT' as const, line: 3, body: 'hi\n\n<!-- diffle-thread:k -->' }];
    const res = await exportToGithub({ snap, threads: [thread({ id: 'k' })], run: runner('PRR_1', existing) });
    expect(res).toEqual({ url: PR_URL, posted: 0, updated: 0, review: 'existing', skipped: [{ id: 'k', reason: 'already in the review' }] });
    // Nothing was written: the list is the last call.
    expect(calls.map((c) => c.args[0])).toEqual(['pr', 'api', 'api']);
  });

  it('rewrites the comment in place when the thread was edited, matching path, side and lines', async () => {
    const existing = [
      { node_id: 'C_1', path: 'a.txt', side: 'RIGHT' as const, line: 3, body: 'stale text\n\n<!-- diffle-thread:k -->' },
      { node_id: 'C_2', path: 'a.txt', side: 'LEFT' as const, line: 8, start_line: 5, body: 'gone\n\n<!-- diffle-thread:o -->' },
    ];
    const threads = [thread({ id: 'k', body: 'hi' }), thread({ id: 'o', side: 'old', line: 5, endLine: 8, body: 'gone' }), thread({ id: 'n', line: 9, body: 'new one' })];
    const res = await exportToGithub({ snap, threads, run: runner('PRR_1', existing) });
    expect(res).toEqual({ url: PR_URL, posted: 1, updated: 1, review: 'existing', skipped: [{ id: 'o', reason: 'already in the review' }] });
    const inputs = calls.slice(3).map((c) => (JSON.parse(c.input!) as { variables: { input: unknown } }).variables.input);
    expect(inputs).toEqual([
      { pullRequestReviewCommentId: 'C_1', body: 'hi\n\n<!-- diffle-thread:k -->' },
      { pullRequestReviewId: 'PRR_1', path: 'a.txt', line: 9, side: 'RIGHT', body: 'new one\n\n<!-- diffle-thread:n -->' },
    ]);
  });

  it('side and lines are part of the identity: a comment on the other side is not a match', async () => {
    const existing = [{ node_id: 'C_1', path: 'a.txt', side: 'LEFT' as const, line: 3, body: 'hi\n\n<!-- diffle-thread:k -->' }];
    const res = await exportToGithub({ snap, threads: [thread({ id: 'k' })], run: runner('PRR_1', existing) });
    expect(res).toMatchObject({ posted: 1, updated: 0, skipped: [] });
  });

  it('two threads on one line become two comments: the matched comment is claimed once', async () => {
    const existing = [{ node_id: 'C_1', path: 'a.txt', side: 'RIGHT' as const, line: 3, body: 'first\n\n<!-- diffle-thread:a -->' }];
    const threads = [thread({ id: 'a', body: 'first' }), thread({ id: 'b', body: 'second' })];
    const res = await exportToGithub({ snap, threads, run: runner('PRR_1', existing) });
    expect(res).toMatchObject({ posted: 1, updated: 0, skipped: [{ id: 'a', reason: 'already in the review' }] });
  });

  it('leaves an untagged GitHub draft on the same lines untouched', async () => {
    const existing = [{ node_id: 'C_1', path: 'a.txt', side: 'RIGHT' as const, line: 3, body: 'My GitHub draft' }];
    const res = await exportToGithub({ snap, threads: [thread({ id: 'k' })], run: runner('PRR_1', existing) });
    expect(res).toMatchObject({ posted: 1, updated: 0 });
    expect(JSON.parse(calls[3]!.input!).variables.input).toEqual({
      pullRequestReviewId: 'PRR_1', path: 'a.txt', line: 3, side: 'RIGHT', body: 'hi\n\n<!-- diffle-thread:k -->',
    });
  });

  it('re-exporting only the second same-line thread updates only its comment', async () => {
    const existing = [
      { node_id: 'C_A', path: 'a.txt', side: 'RIGHT' as const, line: 3, body: 'first\n\n<!-- diffle-thread:a -->' },
      { node_id: 'C_B', path: 'a.txt', side: 'RIGHT' as const, line: 3, body: 'second\n\n<!-- diffle-thread:b -->' },
    ];
    const threads = [thread({ id: 'a', body: 'first' }), thread({ id: 'b', body: 'edited' })];
    const res = await exportToGithub({ snap, threads, threadIds: ['b'], run: runner('PRR_1', existing) });
    expect(res).toMatchObject({ posted: 0, updated: 1 });
    expect(calls).toHaveLength(4);
    expect(JSON.parse(calls[3]!.input!).variables.input).toEqual({
      pullRequestReviewCommentId: 'C_B', body: 'edited\n\n<!-- diffle-thread:b -->',
    });
  });

  it('finds an exported comment on a later page before deciding to add it', async () => {
    const paginated: GhRunner = async (args, opts) => {
      if (args[1] === 'graphql' && JSON.parse(opts.input!).query.includes('reviewThreads')) {
        calls.push({ args, input: opts.input });
        const after = JSON.parse(opts.input!).variables.after;
        const nodes = after === null ? [] : threadNodes([
          { node_id: 'C_1', path: 'a.txt', side: 'RIGHT', line: 3, body: 'hi\n\n<!-- diffle-thread:k -->' },
        ], 'PRR_1');
        return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
          nodes, pageInfo: { hasNextPage: after === null, endCursor: 'page-1' },
        } } } } });
      }
      return runner('PRR_1')(args, opts);
    };
    const res = await exportToGithub({ snap, threads: [thread({ id: 'k' })], run: paginated });
    expect(res).toMatchObject({ posted: 0, updated: 0, skipped: [{ id: 'k', reason: 'already in the review' }] });
    expect(calls).toHaveLength(4);
    expect(JSON.parse(calls[3]!.input!).variables.after).toBe('page-1');
  });

  it.each(['failure', 'limit', 'missing cursor', 'missing data'])('does not write after an incomplete lookup: %s', async (kind) => {
    let pages = 0;
    const incomplete: GhRunner = async (args, opts) => {
      if (args[1] === 'graphql' && JSON.parse(opts.input!).query.includes('reviewThreads')) {
        pages++;
        if (kind === 'failure' && pages === 2) throw new GithubError('lookup failed', 502);
        const nodes = threadNodes([{ node_id: 'C_1', path: 'a.txt', side: 'RIGHT', line: 3, body: 'old\n\n<!-- diffle-thread:k -->' }], 'PRR_1');
        const reviewThreads = kind === 'missing data' ? null : {
          nodes, pageInfo: { hasNextPage: true, endCursor: kind === 'missing cursor' ? null : `page-${pages}` },
        };
        return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads } } } });
      }
      return runner('PRR_1')(args, opts);
    };
    await expect(exportToGithub({ snap, threads: [thread({ id: 'k' })], run: incomplete })).rejects.toThrow(GithubError);
    expect(calls).toHaveLength(2);
    expect(pages).toBe(kind === 'limit' ? 10 : kind === 'failure' ? 2 : 1);
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

  it('does not write when the pending review cannot be read', async () => {
    const blind: GhRunner = async (args, o) => {
      if (args[1] === 'graphql' && (JSON.parse(o.input!) as { query: string }).query.includes('reviewThreads')) throw new GithubError('gh api graphql failed: 502', 502);
      return runner('PRR_1')(args, o);
    };
    await expect(exportToGithub({ snap, threads: [thread({ id: 'k' })], run: blind })).rejects.toThrow(/502/);
    expect(calls).toHaveLength(2);
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
    await expect(exportToGithub({ snap, threads: [thread({ id: 'k' }), thread({ id: 'k2', line: 9 })], run: flaky })).rejects.toThrow(/updated 0 and added 1 comments/);
  });

  it('overlapping exports add the same thread only once', async () => {
    const existing: Existing[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const adding = new Promise<void>((resolve) => { entered = resolve; });
    const run: GhRunner = async (args, opts) => {
      if (args[1] === 'graphql' && JSON.parse(opts.input!).query.includes('addPullRequestReviewThread')) {
        entered();
        await held;
        existing.push({ node_id: 'C_1', path: 'a.txt', side: 'RIGHT', line: 3, body: 'hi\n\n<!-- diffle-thread:k -->' });
      }
      return runner('PRR_1', existing)(args, opts);
    };
    const input = { snap, threads: [thread({ id: 'k' })], run };
    const first = exportToGithub(input);
    await adding;
    const second = exportToGithub(input);
    // Let the second request reach the held write if exports are no longer serialized.
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    expect(await first).toMatchObject({ posted: 1 });
    expect(await second).toMatchObject({ posted: 0, skipped: [{ id: 'k', reason: 'already in the review' }] });
    expect(existing).toHaveLength(1);
  });

  it('a failed export does not block the next export', async () => {
    const failed = exportToGithub({ snap, threads: [thread({ id: 's', stale: true })], run: gh });
    const next = exportToGithub({ snap, threads: [thread({ id: 'k' })], run: gh });
    await expect(failed).rejects.toThrow('nothing to post');
    await expect(next).resolves.toMatchObject({ posted: 1 });
  });

  it.each([0, 1])('reports completed updates when an append fails after %i additions', async (additions) => {
    const existing: Existing[] = [{ node_id: 'C_1', path: 'a.txt', side: 'RIGHT', line: 3, body: 'old\n\n<!-- diffle-thread:k -->' }];
    let added = 0;
    const run: GhRunner = async (args, opts) => {
      if (args[1] === 'graphql' && JSON.parse(opts.input!).query.includes('addPullRequestReviewThread') && added++ === additions) {
        throw new GithubError('line outside the diff', 502);
      }
      return runner('PRR_1', existing)(args, opts);
    };
    await expect(exportToGithub({ snap, threads: [thread({ id: 'k' }), thread({ id: 'a', line: 8 }), thread({ id: 'b', line: 9 })], run }))
      .rejects.toMatchObject({ status: 502, message: `updated 1 and added ${additions} comments in the pending review, then line outside the diff` });
  });

  it('reports completed updates when a later update fails', async () => {
    const existing: Existing[] = [
      { node_id: 'C_1', path: 'a.txt', side: 'RIGHT', line: 3, body: 'old\n\n<!-- diffle-thread:k -->' },
      { node_id: 'C_2', path: 'a.txt', side: 'RIGHT', line: 8, body: 'old\n\n<!-- diffle-thread:a -->' },
    ];
    let updated = 0;
    const run: GhRunner = async (args, opts) => {
      if (args[1] === 'graphql' && JSON.parse(opts.input!).query.includes('updatePullRequestReviewComment') && updated++ === 1) {
        throw new GithubError('update failed', 502);
      }
      return runner('PRR_1', existing)(args, opts);
    };
    await expect(exportToGithub({ snap, threads: [thread({ id: 'k' }), thread({ id: 'a', line: 8 })], run }))
      .rejects.toMatchObject({ status: 502, message: 'updated 1 and added 0 comments in the pending review, then update failed' });
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
