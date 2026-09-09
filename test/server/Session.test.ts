import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitRepo } from '../../src/server/git/GitRepo.js';
import { Session, sidePath, readablePaths, type WatcherLike } from '../../src/server/Session.js';
import type { ServerMessage, Snapshot } from '../../src/shared/protocol.js';

let dir: string;
let outside: string;
let repo: GitRepo;
const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  }).trim();

const hub = {
  messages: [] as ServerMessage[],
  broadcast(m: ServerMessage) {
    this.messages.push(m);
  },
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'diffle-session-'));
  outside = await mkdtemp(join(tmpdir(), 'diffle-outside-'));
  await writeFile(join(outside, 'secret.txt'), 'host secret\n');
  git('init', '-q', '-b', 'main');
  await writeFile(join(dir, 'old.txt'), 'alpha\nbeta\ngamma\n');
  await writeFile(join(dir, 'same.txt'), 'same\n');
  await writeFile(join(dir, '.gitignore'), '*.env\n');
  await symlink(join(outside, 'secret.txt'), join(dir, 'link.txt'));
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feat');
  git('mv', 'old.txt', 'new.txt');
  await writeFile(join(dir, 'new.txt'), 'alpha\nbeta\ngamma\ndelta\n');
  git('commit', '-q', '-am', 'rename + edit');
  await writeFile(join(dir, 'secret.env'), 'TOKEN=1\n');
  repo = await GitRepo.open(dir);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('sidePath', () => {
  const snap = {
    changed: [
      { path: 'new.txt', oldPath: 'old.txt', status: 'R' },
      { path: 'gone.txt', status: 'D' },
      { path: 'added.txt', status: 'A' },
    ],
    tree: ['new.txt', 'same.txt', 'added.txt'],
  } as unknown as Snapshot;
  const r = readablePaths(snap);

  it('maps a renamed file to its old path on the old side and keeps the new path on the new side', () => {
    expect(sidePath(r, 'new.txt', 'old')).toBe('old.txt');
    expect(sidePath(r, 'new.txt', 'new')).toBe('new.txt');
    expect(sidePath(r, 'old.txt', 'old')).toBe('old.txt');
  });

  it('exposes deleted files on the old side only and refuses paths outside the snapshot', () => {
    expect(sidePath(r, 'gone.txt', 'old')).toBe('gone.txt');
    expect(sidePath(r, 'gone.txt', 'new')).toBeNull();
    expect(sidePath(r, 'same.txt', 'old')).toBe('same.txt');
    for (const p of ['.git/config', 'secret.env', '../etc/passwd', 'nope.txt']) {
      expect(sidePath(r, p, 'new')).toBeNull();
      expect(sidePath(r, p, 'old')).toBeNull();
    }
  });
});

describe('Session', () => {
  it('reads both sides of a renamed file by its new path and relocates comments on it', async () => {
    const session = new Session(repo, hub, { watch: false, context: 3 });
    const snap = await session.start({ kind: 'revspec', args: ['main..feat'] });
    expect(snap.tree).toEqual(['.gitignore', 'link.txt', 'new.txt', 'same.txt']);
    expect((await session.readSide(snap, 'new.txt', 'old'))?.toString()).toBe('alpha\nbeta\ngamma\n');
    expect((await session.readSide(snap, 'new.txt', 'new'))?.toString()).toBe('alpha\nbeta\ngamma\ndelta\n');
    expect(await session.readSide(snap, 'old.txt', 'new')).toBeNull();

    await session.comments.clear();
    const c = await session.comments.addThread(
      { path: 'new.txt', side: 'old', startLine: 2, endLine: 2, quoted: 'beta' },
      { body: 'old-side note' },
    );
    await session.refresh();
    expect(session.comments.get(c.id)?.stale).toBe(false);
    await session.close();
  });

  it('flags threads stale whose lines left the diff, on start and on context change', async () => {
    const session = new Session(repo, hub, { watch: false, context: 0 });
    await session.start({ kind: 'revspec', args: ['main..feat'] });
    await session.comments.clear();
    // Context 0 shows only `delta`; `alpha` exists on both sides but is outside every hunk.
    const outside = await session.comments.addThread(
      { path: 'new.txt', side: 'new', startLine: 1, endLine: 1, quoted: 'alpha' },
      { body: 'context line' },
    );
    const inside = await session.comments.addThread(
      { path: 'new.txt', side: 'new', startLine: 4, endLine: 4, quoted: 'delta' },
      { body: 'added line' },
    );
    // `same.txt` is not part of the diff: nothing can display an old-side thread on it, the file view shows a new-side one.
    const unchangedOld = await session.comments.addThread(
      { path: 'same.txt', side: 'old', startLine: 1, endLine: 1, quoted: 'same' },
      { body: 'x' },
    );
    const unchangedNew = await session.comments.addThread(
      { path: 'same.txt', side: 'new', startLine: 1, endLine: 1, quoted: 'same' },
      { body: 'y' },
    );
    await session.refresh();
    const stale = () => [outside, inside, unchangedOld, unchangedNew].map((t) => session.comments.get(t.id)?.stale);
    expect(stale()).toEqual([true, false, true, false]);
    expect(session.comments.get(outside.id)?.staleFromLine).toBe(1);

    // Three lines of context bring `alpha` back into the hunk.
    await session.setContext(3);
    expect(stale()).toEqual([false, false, true, false]);
    await session.setContext(0);
    expect(stale()).toEqual([true, false, true, false]);
    await session.close();

    // A fresh session relocates against the snapshot before serving anything.
    const again = new Session(repo, hub, { watch: false, context: 3 });
    await again.start({ kind: 'revspec', args: ['main..feat'] });
    expect(again.comments.get(outside.id)?.stale).toBe(false);
    await again.comments.clear();
    await again.close();
  });

  it('notifies snapshot listeners on start, refresh, context change and mode switch, in version order', async () => {
    const session = new Session(repo, hub, { watch: false, context: 0 });
    const seen: number[] = [];
    const off = session.onSnapshot((snap) => seen.push(snap.version));
    const first = await session.start({ kind: 'revspec', args: ['main..feat'] });
    await session.refresh();
    await session.setContext(3);
    await session.switchMode({ kind: 'working' });
    expect(seen[0]).toBe(first.version);
    expect(seen).toHaveLength(4);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    off();
    await session.refresh();
    expect(seen).toHaveLength(4);
    await session.close();
  });

  it('quotes a range from the snapshot for imports and refuses ranges it cannot read', async () => {
    const session = new Session(repo, hub, { watch: false, context: 3 });
    await session.start({ kind: 'revspec', args: ['main..feat'] });
    const quote = session.quoter();
    expect(await quote('new.txt', 'new', 2, 4)).toBe('beta\ngamma\ndelta');
    expect(await quote('new.txt', 'old', 1, 1)).toBe('alpha');
    expect(await quote('new.txt', 'new', 4, 5)).toBeNull();
    expect(await quote('secret.env', 'new', 1, 1)).toBeNull();
    await session.close();
  });

  it('flags generated files in the snapshot by path and by content', async () => {
    await writeFile(join(dir, 'gen.py'), '# @generated by tool\nx = 1\n');
    await writeFile(join(dir, 'plain.py'), 'x = 1\n');
    await writeFile(join(dir, 'yarn.lock'), '# yarn\n');
    try {
      const session = new Session(repo, hub, { watch: false, context: 3 });
      const snap = await session.start({ kind: 'working' });
      const gen = Object.fromEntries(snap.changed.map((f) => [f.path, f.generated]));
      expect(gen).toMatchObject({ 'gen.py': true, 'plain.py': false, 'yarn.lock': true });
      await session.close();
    } finally {
      await rm(join(dir, 'gen.py'));
      await rm(join(dir, 'plain.py'));
      await rm(join(dir, 'yarn.lock'));
    }
  });

  it('refuses ignored files, git internals, traversal, and returns a symlink as its target string', async () => {
    const session = new Session(repo, hub, { watch: false, context: 3 });
    const snap = await session.start({ kind: 'working' });
    expect(await session.readSide(snap, 'secret.env', 'new')).toBeNull();
    expect(await session.readSide(snap, '.git/config', 'new')).toBeNull();
    expect(await session.readSide(snap, '../etc/passwd', 'new')).toBeNull();
    expect(await session.readSide(snap, join(outside, 'secret.txt'), 'new')).toBeNull();
    const link = await session.readSide(snap, 'link.txt', 'new');
    expect(link?.toString()).toBe(join(outside, 'secret.txt'));
    expect(link?.toString()).not.toContain('host secret');
    await session.close();
  });

  it('keeps versions monotonic and the context agreed when a context change and a refresh interleave a slow mode switch', async () => {
    const slow = gatedRepo();
    const session = new Session(slow.repo, hub, { watch: false, context: 3 });
    const seen: Snapshot[] = [];
    session.onSnapshot((snap) => seen.push(snap));
    await session.start({ kind: 'revspec', args: ['main..feat'] });
    // The switch to working mode blocks inside git; the other two arrive meanwhile.
    slow.hold();
    const switching = session.switchMode({ kind: 'working' });
    await slow.reached;
    const context = session.setContext(5);
    const refreshed = session.refresh();
    slow.release();
    await Promise.all([switching, context, refreshed]);
    const versions = seen.map((snap) => snap.version);
    expect(versions.every((v, i) => i === 0 || v > versions[i - 1]!)).toBe(true);
    expect(session.mode.kind).toBe('working');
    const current = await session.snapshotter.current();
    expect(session.context).toBe(5);
    expect(current.context).toBe(5);
    expect(current.version).toBe(versions.at(-1));
    await session.close();
  });

  it('coalesces refreshes: at most one waits behind the running one', async () => {
    const slow = gatedRepo();
    const session = new Session(slow.repo, hub, { watch: false, context: 3 });
    await session.start({ kind: 'revspec', args: ['main..feat'] });
    slow.hold();
    const running = session.refresh();
    await slow.reached;
    const burst = [session.refresh(), session.refresh(), session.refresh()];
    expect(new Set(burst).size).toBe(1);
    slow.calls = 0;
    slow.release();
    await Promise.all([running, ...burst]);
    expect(slow.calls).toBe(1);
    await session.close();
  });

  it('refreshes the live worktree snapshot when only the index changes', async () => {
    // Own repo: the real chokidar watcher must see a `git add -f` of an ignored file that never changed on disk.
    const live = await mkdtemp(join(tmpdir(), 'diffle-live-'));
    const liveGit = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: live,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@t',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@t',
          GIT_CONFIG_GLOBAL: '/dev/null',
        },
      }).trim();
    try {
      liveGit('init', '-q', '-b', 'main');
      await writeFile(join(live, '.gitignore'), '*.env\n');
      await writeFile(join(live, 'secret.env'), 'TOKEN=1\n');
      liveGit('add', '.gitignore');
      liveGit('commit', '-q', '-m', 'base');
      const session = new Session(await GitRepo.open(live), hub, { watch: true, context: 3 });
      const nextSnapshot = () =>
        new Promise<Snapshot>((resolve) => {
          const off = session.onSnapshot((snap) => {
            off();
            resolve(snap);
          });
        });
      const first = await session.start({ kind: 'working' });
      expect(first.changed).toEqual([]);
      expect(first.tree).toEqual(['.gitignore']);

      let next = nextSnapshot();
      liveGit('add', '-f', 'secret.env');
      const staged = await next;
      expect(staged.version).toBeGreaterThan(first.version);
      expect(staged.changed.map((f) => f.path)).toEqual(['secret.env']);
      expect(staged.tree).toEqual(['.gitignore', 'secret.env']);

      // HEAD moves without any worktree write: the index watcher shares its instance with the refs.
      next = nextSnapshot();
      liveGit('commit', '-q', '-m', 'force-added');
      const committed = await next;
      expect(committed.headSha).not.toBe(staged.headSha);
      expect(committed.changed).toEqual([]);
      await session.close();
    } finally {
      await rm(live, { recursive: true, force: true });
    }
  });

  it('serializes concurrent mode switches: the last request wins and owns the only watcher', async () => {
    const watchers: FakeWatcher[] = [];
    let delay = 50;
    const session = new Session(repo, hub, {
      watch: true,
      context: 3,
      createWatcher: () => {
        const w = new FakeWatcher(delay);
        delay = 0; // only the first watcher is slow
        watchers.push(w);
        return w;
      },
    });
    await session.start({ kind: 'revspec', args: ['main..feat'] });
    const a = session.switchMode({ kind: 'working' });
    const b = session.switchMode({ kind: 'revspec', args: ['main'] });
    const [snapA, snapB] = await Promise.all([a, b]);
    expect(snapB.version).toBeGreaterThan(snapA.version);
    expect(session.mode.label).toBe('main...HEAD');
    expect(session.comments.key).toBe(session.mode.commentKey);
    expect(watchers.map((w) => w.state)).toEqual(['closed', 'closed', 'open']);
    await session.close();
    expect(watchers.map((w) => w.state)).toEqual(['closed', 'closed', 'closed']);
  });
});

/**
 * `repo` with a `numstat` the test can hold: `hold()` blocks the next calls
 * until `release()`; `reached` resolves once a call is waiting.
 */
function gatedRepo() {
  let gate: Promise<void> | null = null;
  let release = () => {};
  let onReach = () => {};
  const g = {
    repo: Object.create(repo) as GitRepo,
    calls: 0,
    reached: Promise.resolve(),
    hold() {
      gate = new Promise<void>((r) => (release = r));
      g.reached = new Promise<void>((r) => (onReach = r));
    },
    release() {
      release();
      gate = null;
    },
  };
  g.repo.numstat = async (oldRev, newRev) => {
    g.calls++;
    onReach();
    if (gate) await gate;
    return repo.numstat(oldRev, newRev);
  };
  return g;
}

class FakeWatcher implements WatcherLike {
  state: 'new' | 'open' | 'closed' = 'new';
  constructor(private readonly startDelay: number) {}
  on(): this {
    return this;
  }
  async start(): Promise<void> {
    await new Promise((r) => setTimeout(r, this.startDelay));
    this.state = 'open';
  }
  async close(): Promise<void> {
    this.state = 'closed';
  }
}
