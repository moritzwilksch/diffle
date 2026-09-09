import { describe, expect, it } from 'vitest';
import type { CommentThread } from '../../src/shared/protocol.js';
import { buildReview, exportToGithub, formatBody, GithubError, type GhRunner } from '../../src/server/github.js';

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
    expect(review.event).toBe('COMMENT');
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

describe('exportToGithub', () => {
  const calls: { args: string[]; input?: string }[] = [];
  const gh: GhRunner = async (args, { input }) => {
    calls.push({ args, input });
    if (args[0] === 'pr') return JSON.stringify({ number: 7, url: 'https://github.com/o/r/pull/7', headRefOid: HEAD });
    return '{}';
  };

  it('refuses the worktree and a new side that is not HEAD', async () => {
    const threads = [thread({ id: 'k' })];
    await expect(exportToGithub({ snap: { root: '/r', newSha: 'worktree', headSha: HEAD }, threads, run: gh })).rejects.toThrow(GithubError);
    await expect(exportToGithub({ snap: { root: '/r', newSha: 'b'.repeat(40), headSha: HEAD }, threads, run: gh })).rejects.toThrow(/checked-out commit/);
    expect(calls).toEqual([]);
  });

  it('posts one review through gh api from the repo root', async () => {
    calls.length = 0;
    const res = await exportToGithub({ snap: { root: '/r', newSha: HEAD, headSha: HEAD }, threads: [thread({ id: 'k' }), thread({ id: 's', stale: true })], run: gh });
    expect(res).toEqual({ url: 'https://github.com/o/r/pull/7', posted: 1, skipped: [{ id: 's', reason: 'stale' }] });
    expect(calls[0]!.args).toEqual(['pr', 'view', '--json', 'number,url,headRefOid']);
    expect(calls[1]!.args).toEqual(['api', '--method', 'POST', 'repos/{owner}/{repo}/pulls/7/reviews', '--input', '-']);
    expect(JSON.parse(calls[1]!.input!)).toMatchObject({ commit_id: HEAD, event: 'COMMENT', comments: [{ path: 'a.txt', line: 3, side: 'RIGHT' }] });
  });

  it('refuses when the PR head is not the local HEAD, before posting', async () => {
    calls.length = 0;
    const behind: GhRunner = async (args, o) => (args[0] === 'pr' ? JSON.stringify({ number: 7, url: 'u', headRefOid: 'c'.repeat(40) }) : gh(args, o));
    await expect(exportToGithub({ snap: { root: '/r', newSha: HEAD, headSha: HEAD }, threads: [thread({ id: 'k' })], run: behind })).rejects.toThrow(/push first/);
    expect(calls).toEqual([]);
  });

  it('answers 400 when every thread is skipped', async () => {
    await expect(exportToGithub({ snap: { root: '/r', newSha: HEAD, headSha: HEAD }, threads: [thread({ id: 's', stale: true })], run: gh })).rejects.toMatchObject({ status: 400, message: /1 stale/ });
  });
});
