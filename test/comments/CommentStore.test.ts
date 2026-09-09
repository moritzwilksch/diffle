import { mkdir, mkdtemp, readdir, readFile, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommentStore, NotFoundError, UnquotableError } from '../../src/server/comments/CommentStore.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'diffle-store-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const anchor = { path: 'a.py', side: 'new' as const, startLine: 2, endLine: 2, quoted: 'b' };
const hello = { body: 'hello' };

describe('CommentStore', () => {
  it('persists threads per mode key and reloads them', async () => {
    const s1 = await CommentStore.open(dir, 'working');
    const t = await s1.addThread(anchor, hello);
    expect(t.id).toBeTruthy();
    expect(t.messages[0]).toMatchObject({ body: 'hello' });
    const s2 = await CommentStore.open(dir, 'working');
    expect(s2.threads()).toEqual([t]);
    const other = await CommentStore.open(dir, 'pr:abc');
    expect(other.threads()).toEqual([]);
    const raw = JSON.parse(await readFile(join(dir, 'diffle', 'comments.json'), 'utf8'));
    expect(raw.version).toBe(2);
    expect(Object.keys(raw.sets)).toEqual(['working']);
    // Quoted source lines: owner-only.
    expect((await stat(join(dir, 'diffle', 'comments.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'diffle'))).mode & 0o777).toBe(0o700);
  });

  it('migrates a v1 file once, keeping a backup', async () => {
    await mkdir(join(dir, 'diffle'), { recursive: true });
    const v1 = {
      version: 1,
      sets: {
        working: {
          comments: [{ id: 'c1', anchor, body: 'old note', createdAt: 5, updatedAt: 6, stale: true, staleFromLine: 9 }],
          viewed: [{ path: 'a.py', blob: 'sha', viewed: true }],
        },
      },
    };
    await writeFile(join(dir, 'diffle', 'comments.json'), JSON.stringify(v1));
    const s = await CommentStore.open(dir, 'working');
    const [t] = s.threads();
    expect(t).toMatchObject({ id: 'c1', anchor, resolved: false, stale: true, staleFromLine: 9 });
    expect(t!.messages).toHaveLength(1);
    expect(t!.messages[0]).toMatchObject({ body: 'old note', createdAt: 5, updatedAt: 6 });
    expect(s.viewed()).toEqual([{ path: 'a.py', blob: 'sha', viewed: true }]);
    expect(JSON.parse(await readFile(join(dir, 'diffle', 'comments.v1.bak'), 'utf8'))).toEqual(v1);
    await s.reply('c1', { body: 'reply' });
    const raw = JSON.parse(await readFile(join(dir, 'diffle', 'comments.json'), 'utf8'));
    expect(raw.version).toBe(2);
    expect(raw.sets.working.threads[0].messages).toHaveLength(2);
  });

  it('replies, edits, removes messages and threads, resolves, and clears', async () => {
    const s = await CommentStore.open(dir, 'working');
    const t = await s.addThread(anchor, hello);
    await s.reply(t.id, { body: 'fixed' });
    expect(s.get(t.id)?.messages.map((m) => m.body)).toEqual(['hello', 'fixed']);
    const [first, second] = s.get(t.id)!.messages;
    await s.editMessage(t.id, first!.id, 'hello again');
    expect(s.get(t.id)?.messages[0]?.body).toBe('hello again');
    expect(await s.removeMessage(t.id, second!.id)).toMatchObject({ id: t.id });
    expect(s.get(t.id)?.messages).toHaveLength(1);
    await s.setResolved(t.id, true);
    expect(s.get(t.id)).toMatchObject({ resolved: true, resolvedAt: expect.any(Number) });
    expect(s.threads({ state: 'open' })).toEqual([]);
    expect(s.threads({ state: 'resolved' })).toHaveLength(1);
    await s.setResolved(t.id, false);
    expect(s.get(t.id)?.resolvedAt).toBeUndefined();
    // The last message takes the thread with it.
    expect(await s.removeMessage(t.id, first!.id)).toBeNull();
    expect(s.threads()).toEqual([]);
    await expect(s.removeThread(t.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(s.reply('nope', { body: 'x' })).rejects.toBeInstanceOf(NotFoundError);
    await s.addThread(anchor, hello);
    await s.clear();
    expect(s.threads()).toEqual([]);
  });

  it('filters by path, ordered by path then line', async () => {
    const s = await CommentStore.open(dir, 'working');
    await s.addThread({ ...anchor, path: 'z.py', startLine: 1, endLine: 1 }, { body: 'z' });
    await s.addThread({ ...anchor, startLine: 9, endLine: 9 }, hello);
    await s.addThread(anchor, { body: 'a' });
    expect(s.threads().map((t) => `${t.anchor.path}:${t.anchor.startLine}`)).toEqual(['a.py:2', 'a.py:9', 'z.py:1']);
    expect(s.threads({ path: 'z.py' })).toHaveLength(1);
  });

  it('imports payloads, quoting from the snapshot and skipping open duplicates', async () => {
    const s = await CommentStore.open(dir, 'working');
    const quote = async (path: string, _side: string, start: number, end: number) => (path === 'a.py' && end <= 3 ? `L${start}-${end}` : null);
    const first = await s.importThreads([{ path: 'a.py', startLine: 1, body: 'one' }], quote);
    expect(first.skipped).toBe(0);
    expect(first.added[0]).toMatchObject({ anchor: { path: 'a.py', side: 'new', startLine: 1, endLine: 1, quoted: 'L1-1' } });
    expect(first.added[0]!.messages[0]).toMatchObject({ body: 'one' });
    const second = await s.importThreads(
      [
        { path: 'a.py', startLine: 1, body: 'one' },
        { path: 'a.py', startLine: 2, endLine: 3, body: 'two', quoted: 'given' },
        { path: 'a.py', startLine: 2, endLine: 3, body: 'two' },
      ],
      quote,
    );
    expect(second).toMatchObject({ skipped: 2 });
    expect(second.added.map((t) => t.anchor.quoted)).toEqual(['given']);
    // A resolved thread no longer counts as a duplicate.
    await s.setResolved(first.added[0]!.id, true);
    expect((await s.importThreads([{ path: 'a.py', startLine: 1, body: 'one' }], quote)).added).toHaveLength(1);
    // An unquotable range adds nothing from the batch.
    await expect(s.importThreads([{ path: 'a.py', startLine: 1, body: 'new' }, { path: 'a.py', startLine: 8, body: 'x' }], quote)).rejects.toBeInstanceOf(UnquotableError);
    expect(s.threads().some((t) => t.messages[0]!.body === 'new')).toBe(false);
  });

  it('keeps the newest previous viewed mark per path and caps the history', async () => {
    const s = await CommentStore.open(dir, 'working');
    await s.setViewed('a.py', 'sha1', true);
    await s.setViewed('a.py', 'sha1', false);
    expect(s.viewed()).toEqual([{ path: 'a.py', blob: 'sha1', viewed: false }]);
    await s.setViewed('a.py', 'sha2', true);
    await s.setViewed('a.py', 'sha3', true);
    expect(s.viewed()).toEqual([
      { path: 'a.py', blob: 'sha2', viewed: true },
      { path: 'a.py', blob: 'sha3', viewed: true },
    ]);
    await s.setViewedMany([{ path: 'a.py', blob: 'sha4', viewed: false }]);
    expect(s.viewed()).toEqual([{ path: 'a.py', blob: 'sha4', viewed: false }]);
  });

  it('relocates, flags stale, and un-flags when text returns', async () => {
    const s = await CommentStore.open(dir, 'working');
    const t = await s.addThread(anchor, hello);
    await s.reply(t.id, { body: 'follows the anchor' });
    const whole = (contents: string) => async () => ({ contents, shown: null });
    expect(await s.relocateAll(whole('z\na\nb\n'))).toBe(true);
    expect(s.get(t.id)?.anchor.startLine).toBe(3);
    expect(await s.relocateAll(whole('nothing here\n'))).toBe(true);
    expect(s.get(t.id)?.stale).toBe(true);
    expect(s.get(t.id)?.staleFromLine).toBe(3);
    expect(await s.relocateAll(whole('b\n'))).toBe(true);
    expect(s.get(t.id)?.stale).toBe(false);
    expect(s.get(t.id)?.anchor.startLine).toBe(1);
    expect(await s.relocateAll(whole('b\n'))).toBe(false);
  });

  it('flags a thread stale when its text survives but leaves the shown ranges, and clears it when they return', async () => {
    const s = await CommentStore.open(dir, 'working');
    const t = await s.addThread(anchor, hello);
    const contents = 'a\nb\nc\nd\ne\n';
    expect(await s.relocateAll(async () => ({ contents, shown: [[4, 5]] }))).toBe(true);
    expect(s.get(t.id)?.stale).toBe(true);
    expect(s.get(t.id)?.anchor.startLine).toBe(2);
    expect(await s.relocateAll(async () => ({ contents, shown: [[1, 3]] }))).toBe(true);
    expect(s.get(t.id)?.stale).toBe(false);
    expect(await s.relocateAll(async () => ({ contents, shown: [] }))).toBe(true);
    expect(s.get(t.id)?.stale).toBe(true);
  });

  it('removes stale threads only', async () => {
    const s = await CommentStore.open(dir, 'working');
    const gone = await s.addThread({ ...anchor, quoted: 'missing' }, hello);
    const kept = await s.addThread(anchor, hello);
    await s.relocateAll(async () => ({ contents: 'a\nb\n', shown: null }));
    expect(s.get(gone.id)?.stale).toBe(true);
    expect(await s.removeStale()).toBe(1);
    expect(await s.removeStale()).toBe(0);
    expect(s.threads().map((t) => t.id)).toEqual([kept.id]);
  });

  it('two stores on one file keep each other\'s sets', async () => {
    const working = await CommentStore.open(dir, 'working');
    const pr = await CommentStore.open(dir, 'pr:abc');
    await working.addThread(anchor, { body: 'w' });
    await pr.addThread(anchor, { body: 'p' });
    await working.setViewed('a.py', 'sha', true);
    const raw = JSON.parse(await readFile(join(dir, 'diffle', 'comments.json'), 'utf8')) as { sets: Record<string, { threads: { messages: { body: string }[] }[] }> };
    expect(raw.sets.working!.threads.map((t) => t.messages[0]!.body)).toEqual(['w']);
    expect(raw.sets['pr:abc']!.threads.map((t) => t.messages[0]!.body)).toEqual(['p']);
    expect((await CommentStore.open(dir, 'pr:abc')).threads()).toHaveLength(1);
  });

  it('two open stores on one key see and keep each other\'s writes', async () => {
    const a = await CommentStore.open(dir, 'working');
    const b = await CommentStore.open(dir, 'working');
    const t = await a.addThread(anchor, { body: 'from a' });
    // b never loaded t, yet serves it and must not drop it on its own write.
    expect(b.threads()).toEqual([t]);
    await b.setViewed('a.py', 'sha', true);
    await b.reply(t.id, { body: 'from b' });
    expect(a.get(t.id)?.messages.map((m) => m.body)).toEqual(['from a', 'from b']);
    expect(a.viewed()).toEqual([{ path: 'a.py', blob: 'sha', viewed: true }]);
    const fresh = await CommentStore.open(dir, 'working');
    expect(fresh.threads()).toHaveLength(1);
    expect(fresh.viewed()).toHaveLength(1);
  });

  it('concurrent writes from several stores and keys all survive reload', async () => {
    // An old-mode store finishing a write while the new mode's store starts, plus a second server on the same key.
    const old = await CommentStore.open(dir, 'working');
    const next = await CommentStore.open(dir, 'pr:abc');
    const other = await CommentStore.open(dir, 'working');
    await Promise.all([
      old.setViewed('a.py', 'sha', true),
      next.addThread(anchor, { body: 'n1' }),
      old.addThread(anchor, { body: 'o1' }),
      next.setViewed('b.py', 'sha', true),
      other.addThread(anchor, { body: 'o2' }),
      next.addThread(anchor, { body: 'n2' }),
    ]);
    const working = await CommentStore.open(dir, 'working');
    const pr = await CommentStore.open(dir, 'pr:abc');
    expect(working.threads().map((t) => t.messages[0]!.body).sort()).toEqual(['o1', 'o2']);
    expect(working.viewed()).toEqual([{ path: 'a.py', blob: 'sha', viewed: true }]);
    expect(pr.threads().map((t) => t.messages[0]!.body).sort()).toEqual(['n1', 'n2']);
    expect(pr.viewed()).toEqual([{ path: 'b.py', blob: 'sha', viewed: true }]);
    // Unique temp names and a released lock: nothing left beside the file.
    expect((await readdir(join(dir, 'diffle'))).sort()).toEqual(['comments.json']);
  });

  it('a deletion by one store is not resurrected by another', async () => {
    const a = await CommentStore.open(dir, 'working');
    const b = await CommentStore.open(dir, 'working');
    const t = await a.addThread(anchor, hello);
    expect(b.get(t.id)).toBeDefined();
    await a.removeThread(t.id);
    await b.setViewed('a.py', 'sha', true);
    await expect(b.reply(t.id, { body: 'late' })).rejects.toBeInstanceOf(NotFoundError);
    expect(a.threads()).toEqual([]);
    expect((await CommentStore.open(dir, 'working')).threads()).toEqual([]);
  });

  it('waits for a live lock and takes over a stale one', async () => {
    const s = await CommentStore.open(dir, 'working');
    const lock = `${s.file}.lock`;
    await mkdir(join(dir, 'diffle'), { recursive: true });
    // Held by this (live) process: the write waits until the lock goes away.
    await writeFile(lock, `${process.pid}\n`);
    let done = false;
    const write = s.addThread(anchor, hello).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 80));
    expect(done).toBe(false);
    await unlink(lock);
    await write;
    expect(s.threads()).toHaveLength(1);
    // Left behind by a dead process: taken over at once.
    await writeFile(lock, '999999999\n');
    await s.addThread(anchor, hello);
    expect(s.threads()).toHaveLength(2);
    await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('checks a payload\'s own quoted range against the snapshot before keeping it', async () => {
    const s = await CommentStore.open(dir, 'working');
    const quote = async (path: string) => (path === 'a.py' ? 'from snapshot' : null);
    await expect(s.importThreads([{ path: '../../etc/passwd', startLine: 1, body: 'x', quoted: 'root:x:0:0' }], quote)).rejects.toBeInstanceOf(UnquotableError);
    const { added } = await s.importThreads([{ path: 'a.py', startLine: 1, body: 'x', quoted: 'as shown' }], quote);
    expect(added[0]!.anchor.quoted).toBe('as shown');
  });

  it('a failed write is not acknowledged and does not block the next one', async () => {
    const s = await CommentStore.open(dir, 'working');
    // A directory where the file belongs makes the read-modify-write fail.
    await mkdir(s.file, { recursive: true });
    await expect(s.addThread(anchor, { body: 'first' })).rejects.toThrow();
    await rmdir(s.file);
    await s.addThread(anchor, { body: 'second' });
    const raw = JSON.parse(await readFile(s.file, 'utf8')) as { sets: { working: { threads: { messages: { body: string }[] }[] } } };
    expect(raw.sets.working.threads.map((t) => t.messages[0]!.body)).toEqual(['second']);
    expect((await readdir(join(dir, 'diffle'))).sort()).toEqual(['comments.json']);
  });
});
