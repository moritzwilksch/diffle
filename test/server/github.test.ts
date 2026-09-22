import { beforeEach, describe, expect, it } from 'vitest';
import type { CommentThread } from '../../src/shared/protocol.js';
import { type GithubClient, GithubError } from '../../src/server/github/client.js';
import { repoOfPrUrl } from '../../src/server/github/pulls.js';
import { buildReview, GithubExporter, formatBody, type ExportInput } from '../../src/server/github/review.js';

const PR_URL = 'https://github.com/o/r/pull/7';

const HEAD = 'a'.repeat(40);

function thread(
  over: Partial<CommentThread> & {
    id: string;
    path?: string;
    line?: number;
    endLine?: number;
    side?: 'old' | 'new';
    body?: string;
  },
): CommentThread {
  const { path = 'a.txt', line = 3, endLine = line, side = 'new', body = 'hi', ...rest } = over;
  return {
    anchor: { kind: 'line', path, side, startLine: line, endLine, quoted: 'x' },
    messages: [{ id: `${rest.id}-m`, body, createdAt: 1, updatedAt: 1 }],
    resolved: false,
    stale: false,
    ...rest,
  };
}

/** A thread on the file as a whole. */
function fileThread(id: string, body = 'whole file', path = 'a.txt'): CommentThread {
  return { ...thread({ id, body }), anchor: { kind: 'file', path } };
}

describe('buildReview', () => {
  it('maps sides and multi-line ranges to the review thread shape', () => {
    const { comments, skipped } = buildReview([
      thread({ id: 'n', line: 3 }),
      thread({ id: 'o', side: 'old', line: 5, endLine: 8, body: 'gone' }),
    ]);
    expect(skipped).toEqual([]);
    expect(comments).toEqual([
      { path: 'a.txt', line: 3, side: 'RIGHT', body: 'hi' },
      { path: 'a.txt', line: 8, side: 'LEFT', startLine: 5, startSide: 'LEFT', body: 'gone' },
    ]);
  });

  it('keeps file threads in the comment list, in review order', () => {
    const { comments, ids } = buildReview([thread({ id: 'n', line: 3 }), fileThread('f')]);
    expect(comments).toEqual([
      { path: 'a.txt', subjectType: 'FILE', body: 'whole file' },
      { path: 'a.txt', line: 3, side: 'RIGHT', body: 'hi' },
    ]);
    expect(ids).toEqual(['f', 'n']);
  });

  it('skips stale threads and, without ids, resolved ones', () => {
    const { comments, skipped } = buildReview([
      thread({ id: 's', stale: true }),
      thread({ id: 'r', resolved: true }),
      thread({ id: 'k' }),
    ]);
    expect(comments.map((c) => c.body)).toEqual(['hi']);
    expect(skipped).toEqual([{ id: 's', reason: 'stale' }]);
  });

  it('with ids posts the named threads, resolved included, and reports unknown ids', () => {
    const { comments, skipped } = buildReview(
      [thread({ id: 'r', resolved: true, body: 'done' }), thread({ id: 'k' })],
      ['r', 'nope'],
    );
    expect(comments.map((c) => c.body)).toEqual(['done']);
    expect(skipped).toEqual([{ id: 'nope', reason: 'unknown thread' }]);
  });
});

describe('a review as GitHub receives it', () => {
  // The REST payload and the file comments appended afterwards, kept as JSON so a change to the
  // shape is judged against what GitHub's API is sent.
  it('is the committed payload', async () => {
    const built = buildReview(
      [
        thread({ id: 'kind', path: 'tally/ledger.py', line: 3, endLine: 4, body: 'Say what counts as a refund here.' }),
        thread({
          id: 'symbol',
          path: 'tally/currency.py',
          line: 7,
          body: '`KWD` has no symbol.\n\n```suggestion\n_SYMBOLS = {"KWD": "KD"}\n```',
        }),
        thread({
          id: 'removed',
          path: 'tally/legacy.py',
          side: 'old',
          line: 9,
          endLine: 15,
          body: 'Still called by cron.',
        }),
        fileThread('module', 'Fold this into ledger.py.', 'tally/refunds.py'),
        thread({ id: 'gone', path: 'tally/cli.py', line: 27, body: 'Trips set -e.', stale: true }),
        thread({ id: 'done', path: 'tally/ledger.py', line: 33, body: 'Already handled.', resolved: true }),
      ],
      HEAD,
    );
    await expect(JSON.stringify(built, null, 2) + '\n').toMatchFileSnapshot('__snapshots__/review.json');
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
  const exportToGithub = (input: ExportInput) => exporter.export(async () => input);
  type Call = { query: string; variables: Record<string, unknown> };
  const calls: Call[] = [];
  /** One comment already in the pending review, as a review thread reports it. A file comment has no line. */
  type Existing = {
    node_id: string;
    path: string;
    side?: 'LEFT' | 'RIGHT';
    line?: number;
    start_line?: number;
    body: string;
  };

  /** Which GitHub operation a recorded call was. */
  const op = (c: Call) =>
    c.query.includes('reviewThreads')
      ? 'threads'
      : c.query.startsWith('query')
        ? 'pending'
        : c.query.includes('addPullRequestReviewThread')
          ? 'addThread'
          : c.query.includes('updatePullRequestReviewComment')
            ? 'updateComment'
            : 'createReview';
  const input = (c: Call) => c.variables.input;

  /** `reviewThreads` shape: one thread per comment, all of them on the pending review. */
  const threadNodes = (existing: Existing[], reviewId: string) =>
    existing.map((c) => ({
      path: c.path,
      line: c.line ?? null,
      startLine: c.start_line ?? c.line ?? null,
      diffSide: c.side ?? 'RIGHT',
      subjectType: c.line == null ? 'FILE' : 'LINE',
      comments: { nodes: [{ id: c.node_id, body: c.body, pullRequestReview: { id: reviewId } }] },
    }));

  /**
   * `pending`: the id of a pending review the viewer already has, or null for none.
   * `existing`: the comments that review already holds.
   */
  function client(pending: string | null = null, existing: Existing[] = []): GithubClient {
    return {
      async graphql<T>(query: string, variables: Record<string, unknown>) {
        const call = { query, variables };
        calls.push(call);
        switch (op(call)) {
          case 'threads': {
            const reviewThreads = {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: threadNodes(existing, pending ?? ''),
            };
            return { repository: { pullRequest: { reviewThreads } } } as T;
          }
          case 'pending': {
            const nodes = pending ? [{ id: pending, author: { login: 'me' } }] : [];
            return {
              viewer: { login: 'me' },
              repository: { pullRequest: { id: 'PR_7', reviews: { nodes } } },
            } as T;
          }
          case 'updateComment':
            return { updatePullRequestReviewComment: { pullRequestReviewComment: { id: 'c' } } } as T;
          case 'createReview':
            return { addPullRequestReview: { pullRequestReview: { id: 'PRR_NEW' } } } as T;
          case 'addThread':
            return { addPullRequestReviewThread: { thread: { id: 't' } } } as T;
        }
      },
    };
  }

  /** `fn` answers (or throws for) the calls it wants; `undefined` hands the call to `base`. */
  function intercept(base: GithubClient, fn: (call: Call) => unknown | Promise<unknown>): GithubClient {
    return {
      async graphql<T>(query: string, variables: Record<string, unknown>) {
        const call = { query, variables };
        const out = await fn(call);
        if (out === undefined) return base.graphql<T>(query, variables);
        calls.push(call);
        return out as T;
      },
    };
  }

  const github = client();
  const pullRequest = {
    repository: 'o/r',
    number: 7,
    url: PR_URL,
    title: 'Review',
    state: 'OPEN' as const,
    isDraft: false,
  };
  const snap = { newSha: HEAD };

  beforeEach(() => {
    calls.length = 0;
    exporter = new GithubExporter();
  });

  it('refuses worktree export', async () => {
    const threads = [thread({ id: 'k' })];
    await expect(exportToGithub({ pullRequest, snap: { newSha: 'worktree' }, threads, github })).rejects.toThrow(
      /worktree/,
    );
    expect(calls).toEqual([]);
  });

  it('creates a pending review, without an event, when the viewer has none', async () => {
    const res = await exportToGithub({
      pullRequest,
      snap,
      threads: [thread({ id: 'k' }), thread({ id: 's', stale: true })],
      github,
    });
    expect(res).toEqual({
      url: PR_URL,
      posted: 1,
      updated: 0,
      review: 'created',
      skipped: [{ id: 's', reason: 'stale' }],
    });
    expect(calls.map(op)).toEqual(['pending', 'createReview']);
    expect(calls[0]!.variables).toEqual({ owner: 'o', repo: 'r', number: 7 });
    // No `event`: the review GitHub creates from this stays pending.
    expect(input(calls[1]!)).toEqual({
      pullRequestId: 'PR_7',
      commitOID: HEAD,
      threads: [{ path: 'a.txt', line: 3, side: 'RIGHT', body: 'hi\n\n<!-- diffle-thread:k -->' }],
    });
  });

  it('creates the pending review with its line comments, then appends its file comments as threads', async () => {
    const res = await exportToGithub({
      pullRequest,
      snap,
      threads: [thread({ id: 'k' }), fileThread('f')],
      github,
    });
    expect(res).toEqual({ url: PR_URL, posted: 2, updated: 0, review: 'created', skipped: [] });
    expect(calls.map(op)).toEqual(['pending', 'createReview', 'addThread']);
    expect(input(calls[1]!)).toEqual({
      pullRequestId: 'PR_7',
      commitOID: HEAD,
      threads: [{ path: 'a.txt', line: 3, side: 'RIGHT', body: 'hi\n\n<!-- diffle-thread:k -->' }],
    });
    expect(input(calls[2]!)).toEqual({
      pullRequestReviewId: 'PRR_NEW',
      path: 'a.txt',
      subjectType: 'FILE',
      body: 'whole file\n\n<!-- diffle-thread:f -->',
    });
  });

  it('says how far it got when a file comment cannot be appended to the review it just created', async () => {
    const failing = intercept(github, (c) => {
      if (op(c) === 'addThread') throw new GithubError('GitHub: boom', 502);
    });
    await expect(
      exportToGithub({ pullRequest, snap, threads: [thread({ id: 'k' }), fileThread('f')], github: failing }),
    ).rejects.toThrow(/created the pending review with 1 comments, then .*boom/);
  });

  it('matches, updates and appends file comments in an existing pending review by path', async () => {
    const existing: Existing[] = [
      { node_id: 'C_F', path: 'a.txt', body: 'old text\n\n<!-- diffle-thread:f -->' },
      { node_id: 'C_S', path: 'b.txt', body: 'same\n\n<!-- diffle-thread:s -->' },
      { node_id: 'C_L', path: 'a.txt', side: 'RIGHT', line: 3, body: 'line\n\n<!-- diffle-thread:f -->' },
    ];
    const threads = [fileThread('f', 'new text'), fileThread('s', 'same', 'b.txt'), fileThread('n', 'added', 'c.txt')];
    const res = await exportToGithub({ pullRequest, snap, threads, github: client('PRR_1', existing) });
    expect(res).toEqual({
      url: PR_URL,
      posted: 1,
      updated: 1,
      review: 'existing',
      skipped: [{ id: 's', reason: 'already in the review' }],
    });
    // The line comment carrying f's marker is another anchor: only the file comment is rewritten.
    expect(calls.slice(2).map(input)).toEqual([
      { pullRequestReviewCommentId: 'C_F', body: 'new text\n\n<!-- diffle-thread:f -->' },
      { pullRequestReviewId: 'PRR_1', path: 'c.txt', subjectType: 'FILE', body: 'added\n\n<!-- diffle-thread:n -->' },
    ]);
  });

  it('adds a thread per comment to the pending review the viewer already has', async () => {
    const res = await exportToGithub({
      pullRequest,
      snap,
      threads: [thread({ id: 'k' }), thread({ id: 'o', side: 'old', line: 5, endLine: 8, body: 'gone' })],
      github: client('PRR_1'),
    });
    expect(res).toEqual({ url: PR_URL, posted: 2, updated: 0, review: 'existing', skipped: [] });
    // The read of what the pending review already holds comes before any write; no new review is created.
    expect(calls.map(op)).toEqual(['pending', 'threads', 'addThread', 'addThread']);
    expect(calls.slice(2).map(input)).toEqual([
      { pullRequestReviewId: 'PRR_1', path: 'a.txt', line: 3, side: 'RIGHT', body: 'hi\n\n<!-- diffle-thread:k -->' },
      {
        pullRequestReviewId: 'PRR_1',
        path: 'a.txt',
        line: 8,
        side: 'LEFT',
        body: 'gone\n\n<!-- diffle-thread:o -->',
        startLine: 5,
        startSide: 'LEFT',
      },
    ]);
  });

  it('leaves an identical comment already in the pending review alone', async () => {
    const existing = [
      { node_id: 'C_1', path: 'a.txt', side: 'RIGHT' as const, line: 3, body: 'hi\n\n<!-- diffle-thread:k -->' },
    ];
    const res = await exportToGithub({
      pullRequest,
      snap,
      threads: [thread({ id: 'k' })],
      github: client('PRR_1', existing),
    });
    expect(res).toEqual({
      url: PR_URL,
      posted: 0,
      updated: 0,
      review: 'existing',
      skipped: [{ id: 'k', reason: 'already in the review' }],
    });
    // Nothing was written: the list is the last call.
    expect(calls.map(op)).toEqual(['pending', 'threads']);
  });

  it('rewrites the comment in place when the thread was edited, matching path, side and lines', async () => {
    const existing = [
      {
        node_id: 'C_1',
        path: 'a.txt',
        side: 'RIGHT' as const,
        line: 3,
        body: 'stale text\n\n<!-- diffle-thread:k -->',
      },
      {
        node_id: 'C_2',
        path: 'a.txt',
        side: 'LEFT' as const,
        line: 8,
        start_line: 5,
        body: 'gone\n\n<!-- diffle-thread:o -->',
      },
    ];
    const threads = [
      thread({ id: 'k', body: 'hi' }),
      thread({ id: 'o', side: 'old', line: 5, endLine: 8, body: 'gone' }),
      thread({ id: 'n', line: 9, body: 'new one' }),
    ];
    const res = await exportToGithub({ pullRequest, snap, threads, github: client('PRR_1', existing) });
    expect(res).toEqual({
      url: PR_URL,
      posted: 1,
      updated: 1,
      review: 'existing',
      skipped: [{ id: 'o', reason: 'already in the review' }],
    });
    expect(calls.slice(2).map(input)).toEqual([
      { pullRequestReviewCommentId: 'C_1', body: 'hi\n\n<!-- diffle-thread:k -->' },
      {
        pullRequestReviewId: 'PRR_1',
        path: 'a.txt',
        line: 9,
        side: 'RIGHT',
        body: 'new one\n\n<!-- diffle-thread:n -->',
      },
    ]);
  });

  it('side and lines are part of the identity: a comment on the other side is not a match', async () => {
    const existing = [
      { node_id: 'C_1', path: 'a.txt', side: 'LEFT' as const, line: 3, body: 'hi\n\n<!-- diffle-thread:k -->' },
    ];
    const res = await exportToGithub({
      pullRequest,
      snap,
      threads: [thread({ id: 'k' })],
      github: client('PRR_1', existing),
    });
    expect(res).toMatchObject({ posted: 1, updated: 0, skipped: [] });
  });

  it('two threads on one line become two comments: the matched comment is claimed once', async () => {
    const existing = [
      { node_id: 'C_1', path: 'a.txt', side: 'RIGHT' as const, line: 3, body: 'first\n\n<!-- diffle-thread:a -->' },
    ];
    const threads = [thread({ id: 'a', body: 'first' }), thread({ id: 'b', body: 'second' })];
    const res = await exportToGithub({ pullRequest, snap, threads, github: client('PRR_1', existing) });
    expect(res).toMatchObject({ posted: 1, updated: 0, skipped: [{ id: 'a', reason: 'already in the review' }] });
  });

  it('leaves an untagged GitHub draft on the same lines untouched', async () => {
    const existing = [{ node_id: 'C_1', path: 'a.txt', side: 'RIGHT' as const, line: 3, body: 'My GitHub draft' }];
    const res = await exportToGithub({
      pullRequest,
      snap,
      threads: [thread({ id: 'k' })],
      github: client('PRR_1', existing),
    });
    expect(res).toMatchObject({ posted: 1, updated: 0 });
    expect(input(calls[2]!)).toEqual({
      pullRequestReviewId: 'PRR_1',
      path: 'a.txt',
      line: 3,
      side: 'RIGHT',
      body: 'hi\n\n<!-- diffle-thread:k -->',
    });
  });

  it('re-exporting only the second same-line thread updates only its comment', async () => {
    const existing = [
      { node_id: 'C_A', path: 'a.txt', side: 'RIGHT' as const, line: 3, body: 'first\n\n<!-- diffle-thread:a -->' },
      { node_id: 'C_B', path: 'a.txt', side: 'RIGHT' as const, line: 3, body: 'second\n\n<!-- diffle-thread:b -->' },
    ];
    const threads = [thread({ id: 'a', body: 'first' }), thread({ id: 'b', body: 'edited' })];
    const res = await exportToGithub({
      pullRequest,
      snap,
      threads,
      threadIds: ['b'],
      github: client('PRR_1', existing),
    });
    expect(res).toMatchObject({ posted: 0, updated: 1 });
    expect(calls).toHaveLength(3);
    expect(input(calls[2]!)).toEqual({
      pullRequestReviewCommentId: 'C_B',
      body: 'edited\n\n<!-- diffle-thread:b -->',
    });
  });

  it('finds an exported comment on a later page before deciding to add it', async () => {
    const paginated = intercept(client('PRR_1'), (c) => {
      if (op(c) !== 'threads') return;
      const after = c.variables.after;
      const nodes =
        after === null
          ? []
          : threadNodes(
              [{ node_id: 'C_1', path: 'a.txt', side: 'RIGHT', line: 3, body: 'hi\n\n<!-- diffle-thread:k -->' }],
              'PRR_1',
            );
      return {
        repository: {
          pullRequest: { reviewThreads: { nodes, pageInfo: { hasNextPage: after === null, endCursor: 'page-1' } } },
        },
      };
    });
    const res = await exportToGithub({ pullRequest, snap, threads: [thread({ id: 'k' })], github: paginated });
    expect(res).toMatchObject({ posted: 0, updated: 0, skipped: [{ id: 'k', reason: 'already in the review' }] });
    expect(calls.map(op)).toEqual(['pending', 'threads', 'threads']);
    expect(calls[2]!.variables.after).toBe('page-1');
  });

  it.each(['failure', 'limit', 'missing cursor', 'missing data'])(
    'does not write after an incomplete lookup: %s',
    async (kind) => {
      let pages = 0;
      const incomplete = intercept(client('PRR_1'), (c) => {
        if (op(c) !== 'threads') return;
        pages++;
        if (kind === 'failure' && pages === 2) throw new GithubError('lookup failed', 502);
        const nodes = threadNodes(
          [{ node_id: 'C_1', path: 'a.txt', side: 'RIGHT', line: 3, body: 'old\n\n<!-- diffle-thread:k -->' }],
          'PRR_1',
        );
        const reviewThreads =
          kind === 'missing data'
            ? null
            : {
                nodes,
                pageInfo: { hasNextPage: true, endCursor: kind === 'missing cursor' ? null : `page-${pages}` },
              };
        return { repository: { pullRequest: { reviewThreads } } };
      });
      await expect(
        exportToGithub({ pullRequest, snap, threads: [thread({ id: 'k' })], github: incomplete }),
      ).rejects.toThrow(GithubError);
      expect(calls.filter((c) => c.query.startsWith('mutation'))).toEqual([]);
      expect(pages).toBe(kind === 'limit' ? 10 : kind === 'failure' ? 2 : 1);
    },
  );

  it("never rewrites a comment of another review: only the pending review's own count", async () => {
    const submitted = intercept(client('PRR_1'), (c) => {
      if (op(c) !== 'threads') return;
      const nodes = threadNodes([{ node_id: 'C_1', path: 'a.txt', side: 'RIGHT', line: 3, body: 'hi' }], 'PRR_OLD');
      return { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes } } } };
    });
    const res = await exportToGithub({ pullRequest, snap, threads: [thread({ id: 'k' })], github: submitted });
    expect(res).toMatchObject({ posted: 1, updated: 0, skipped: [] });
  });

  it('does not write when the pending review cannot be read', async () => {
    const blind = intercept(client('PRR_1'), (c) => {
      if (op(c) === 'threads') throw new GithubError('GitHub 502: bad gateway', 502);
    });
    await expect(exportToGithub({ pullRequest, snap, threads: [thread({ id: 'k' })], github: blind })).rejects.toThrow(
      /502/,
    );
    expect(calls.map(op)).toEqual(['pending']);
  });

  it("ignores a pending review that is not the viewer's own", async () => {
    const others = intercept(github, (c) => {
      if (op(c) !== 'pending') return;
      return {
        viewer: { login: 'me' },
        repository: {
          pullRequest: { id: 'PR_7', reviews: { nodes: [{ id: 'PRR_2', author: { login: 'someone' } }] } },
        },
      };
    });
    const res = await exportToGithub({ pullRequest, snap, threads: [thread({ id: 'k' })], github: others });
    expect(res.review).toBe('created');
  });

  it('does not create a review when GitHub cannot name the pull request', async () => {
    const nameless = intercept(github, (c) => {
      if (op(c) === 'pending') return { viewer: { login: 'me' }, repository: { pullRequest: null } };
    });
    await expect(
      exportToGithub({ pullRequest, snap, threads: [thread({ id: 'k' })], github: nameless }),
    ).rejects.toMatchObject({ status: 502, message: /cannot read pull request/ });
    expect(calls.map(op)).toEqual(['pending']);
  });

  it('says how many comments already landed when one of the appends fails', async () => {
    let seen = 0;
    const flaky = intercept(client('PRR_1'), (c) => {
      if (c.query.startsWith('mutation') && seen++ === 1) throw new GithubError('GitHub: line outside the diff', 502);
    });
    await expect(
      exportToGithub({
        pullRequest,
        snap,
        threads: [thread({ id: 'k' }), thread({ id: 'k2', line: 9 })],
        github: flaky,
      }),
    ).rejects.toThrow(/updated 0 and added 1 comments/);
  });

  it('overlapping exports add the same thread only once', async () => {
    const existing: Existing[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const adding = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const github = intercept(client('PRR_1', existing), async (c) => {
      if (op(c) !== 'addThread') return;
      entered();
      await held;
      existing.push({
        node_id: 'C_1',
        path: 'a.txt',
        side: 'RIGHT',
        line: 3,
        body: 'hi\n\n<!-- diffle-thread:k -->',
      });
    });
    const input = { snap, pullRequest, threads: [thread({ id: 'k' })], github };
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
    const failed = exportToGithub({ pullRequest, snap, threads: [thread({ id: 's', stale: true })], github });
    const next = exportToGithub({ pullRequest, snap, threads: [thread({ id: 'k' })], github });
    await expect(failed).rejects.toThrow('nothing to post');
    await expect(next).resolves.toMatchObject({ posted: 1 });
  });

  it.each([0, 1])('reports completed updates when an append fails after %i additions', async (additions) => {
    const existing: Existing[] = [
      { node_id: 'C_1', path: 'a.txt', side: 'RIGHT', line: 3, body: 'old\n\n<!-- diffle-thread:k -->' },
    ];
    let added = 0;
    const github = intercept(client('PRR_1', existing), (c) => {
      if (op(c) === 'addThread' && added++ === additions) throw new GithubError('line outside the diff', 502);
    });
    await expect(
      exportToGithub({
        pullRequest,
        snap,
        threads: [thread({ id: 'k' }), thread({ id: 'a', line: 8 }), thread({ id: 'b', line: 9 })],
        github,
      }),
    ).rejects.toMatchObject({
      status: 502,
      message: `updated 1 and added ${additions} comments in the pending review, then line outside the diff`,
    });
  });

  it('reports completed updates when a later update fails', async () => {
    const existing: Existing[] = [
      { node_id: 'C_1', path: 'a.txt', side: 'RIGHT', line: 3, body: 'old\n\n<!-- diffle-thread:k -->' },
      { node_id: 'C_2', path: 'a.txt', side: 'RIGHT', line: 8, body: 'old\n\n<!-- diffle-thread:a -->' },
    ];
    let updated = 0;
    const github = intercept(client('PRR_1', existing), (c) => {
      if (op(c) === 'updateComment' && updated++ === 1) throw new GithubError('update failed', 502);
    });
    await expect(
      exportToGithub({ pullRequest, snap, threads: [thread({ id: 'k' }), thread({ id: 'a', line: 8 })], github }),
    ).rejects.toMatchObject({
      status: 502,
      message: 'updated 1 and added 0 comments in the pending review, then update failed',
    });
  });

  it('answers 400 when every thread is skipped', async () => {
    await expect(
      exportToGithub({ pullRequest, snap, threads: [thread({ id: 's', stale: true })], github }),
    ).rejects.toMatchObject({
      status: 400,
      message: /1 stale/,
    });
  });
});
