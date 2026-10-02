import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rmTmp } from '../tmp.js';
import { GitRepo } from '../../src/server/git/GitRepo.js';
import { type GithubClient, GithubError } from '../../src/server/github/client.js';
import { RevspecError } from '../../src/server/revspec.js';
import { Session, sidePath, readablePaths, type WatcherLike } from '../../src/server/Session.js';
import type { WatchTarget } from '../../src/server/Watcher.js';
import { comparisonLabel, type ServerMessage, type Snapshot } from '../../src/shared/protocol.js';

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
  await rmTmp(dir);
  await rmTmp(outside);
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
    const snap = await session.start(await session.resolve({ kind: 'revspec', args: ['main..feat'] }));
    expect(snap.tree).toEqual(['.gitignore', 'link.txt', 'new.txt', 'same.txt']);
    expect((await session.readSide(snap, 'new.txt', 'old'))?.toString()).toBe('alpha\nbeta\ngamma\n');
    expect((await session.readSide(snap, 'new.txt', 'new'))?.toString()).toBe('alpha\nbeta\ngamma\ndelta\n');
    expect(await session.readSide(snap, 'old.txt', 'new')).toBeNull();

    await session.comments.clear();
    const c = await session.comments.addThread(
      { kind: 'line', path: 'new.txt', side: 'old', startLine: 2, endLine: 2, quoted: 'beta' },
      { body: 'old-side note' },
    );
    await session.refresh();
    expect(session.comments.get(c.id)?.stale).toBe(false);
    await session.close();
  });

  it('keeps close() waiting while a resolution is in flight, so cleanup never races a PR fetch', async () => {
    let asked!: () => void;
    const lookup = new Promise<void>((r) => (asked = r));
    let answer!: (v: unknown) => void;
    const github: GithubClient = {
      graphql: <T>() => {
        asked();
        return new Promise<T>((r) => (answer = r as (v: unknown) => void));
      },
    };
    const session = new Session(repo, hub, { watch: false, context: 3, github });
    const resolving = session.resolve({ kind: 'pr', pr: 'https://github.com/o/r/pull/7' });
    await lookup;
    let closed = false;
    const closing = session.close().then(() => (closed = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(false);
    answer({ repository: { pullRequest: null } });
    await expect(resolving).rejects.toThrow(GithubError);
    await closing;
  });

  it('flags threads stale whose lines left the diff, on start and on context change', async () => {
    const session = new Session(repo, hub, { watch: false, context: 0 });
    await session.start(await session.resolve({ kind: 'revspec', args: ['main..feat'] }));
    await session.comments.clear();
    // Context 0 shows only `delta`; `alpha` exists on both sides but is outside every hunk.
    const outside = await session.comments.addThread(
      { kind: 'line', path: 'new.txt', side: 'new', startLine: 1, endLine: 1, quoted: 'alpha' },
      { body: 'context line' },
    );
    const inside = await session.comments.addThread(
      { kind: 'line', path: 'new.txt', side: 'new', startLine: 4, endLine: 4, quoted: 'delta' },
      { body: 'added line' },
    );
    // `same.txt` is not part of the diff: nothing can display an old-side thread on it, the file view shows a new-side one.
    const unchangedOld = await session.comments.addThread(
      { kind: 'line', path: 'same.txt', side: 'old', startLine: 1, endLine: 1, quoted: 'same' },
      { body: 'x' },
    );
    const unchangedNew = await session.comments.addThread(
      { kind: 'line', path: 'same.txt', side: 'new', startLine: 1, endLine: 1, quoted: 'same' },
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
    await again.start(await again.resolve({ kind: 'revspec', args: ['main..feat'] }));
    expect(again.comments.get(outside.id)?.stale).toBe(false);
    await again.comments.clear();
    await again.close();
  });

  it('notifies snapshot listeners on start, refresh, context change and mode switch, in version order', async () => {
    const session = new Session(repo, hub, { watch: false, context: 0 });
    const seen: number[] = [];
    const off = session.onSnapshot((snap) => seen.push(snap.version));
    const first = await session.start(await session.resolve({ kind: 'revspec', args: ['main..feat'] }));
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

  it('focuses one listed commit of a range, keeps listing the range, and returns to it', async () => {
    const session = new Session(repo, hub, { watch: false, context: 3 });
    const range = await session.start(await session.resolve({ kind: 'revspec', args: ['main..feat'] }));
    const [commit] = range.commits.list;
    const focused = await session.switchMode({ kind: 'focus', commit: commit!.short });
    expect(focused.mode).toEqual({
      old: commit!.sha,
      new: commit!.sha,
      base: 'parent',
      live: 'refs',
      commentKey: `commit:${commit!.sha}`,
      within: range.mode,
    });
    expect(focused.commits).toEqual(range.commits);
    expect(focused.commit?.sha).toBe(commit!.sha);
    // Stepping from one focused commit to another keeps the range, not the commit, as the outer comparison.
    expect((await session.switchMode({ kind: 'focus', commit: commit!.sha })).mode.within).toEqual(range.mode);
    await expect(session.switchMode({ kind: 'focus', commit: 'f'.repeat(40) })).rejects.toThrow(RevspecError);
    expect((await session.switchMode({ kind: 'focus', commit: null })).mode).toEqual(range.mode);
    await session.switchMode({ kind: 'revspec', args: ['feat^!'] });
    await expect(session.switchMode({ kind: 'focus', commit: null })).rejects.toThrow(RevspecError);
    await session.close();
  });

  it('quotes a range from the snapshot for imports and refuses ranges it cannot read', async () => {
    const session = new Session(repo, hub, { watch: false, context: 3 });
    await session.start(await session.resolve({ kind: 'revspec', args: ['main..feat'] }));
    const { quote, hasFile } = session.anchorSource();
    expect(await quote('new.txt', 'new', 2, 4)).toBe('beta\ngamma\ndelta');
    expect(await quote('new.txt', 'old', 1, 1)).toBe('alpha');
    expect(await quote('new.txt', 'new', 4, 5)).toBeNull();
    expect(await quote('secret.env', 'new', 1, 1)).toBeNull();
    // File threads go on the review's files: a changed file by its new path, or any tree path.
    expect(await hasFile('new.txt')).toBe(true);
    expect(await hasFile('same.txt')).toBe(true);
    for (const p of ['old.txt', 'secret.env', '.git/config', '../etc/passwd']) expect(await hasFile(p)).toBe(false);
    await session.close();
  });

  it('keeps a file thread fresh while its file is in the review and flags it when the comparison drops the file', async () => {
    const session = new Session(repo, hub, { watch: false, context: 3 });
    await session.start(await session.resolve({ kind: 'revspec', args: ['main..feat'] }));
    await session.comments.clear();
    const renamed = await session.comments.addThread({ kind: 'file', path: 'new.txt' }, { body: 'split this' });
    const unchanged = await session.comments.addThread({ kind: 'file', path: 'same.txt' }, { body: 'fine' });
    const oldName = await session.comments.addThread({ kind: 'file', path: 'old.txt' }, { body: 'gone' });
    await session.refresh();
    const stale = () => [renamed, unchanged, oldName].map((t) => session.comments.get(t.id)?.stale);
    expect(stale()).toEqual([false, false, true]);
    // A file thread never has a line to remember.
    expect(session.comments.get(oldName.id)?.staleFromLine).toBeUndefined();
    await session.comments.clear();
    await session.close();
  });

  it('flags generated files in the snapshot by path and by content', async () => {
    await writeFile(join(dir, 'gen.py'), '# @generated by tool\nx = 1\n');
    await writeFile(join(dir, 'plain.py'), 'x = 1\n');
    await writeFile(join(dir, 'yarn.lock'), '# yarn\n');
    try {
      const session = new Session(repo, hub, { watch: false, context: 3 });
      const snap = await session.start(await session.resolve({ kind: 'working' }));
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
    const snap = await session.start(await session.resolve({ kind: 'working' }));
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
    await session.start(await session.resolve({ kind: 'revspec', args: ['main..feat'] }));
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
    expect(session.mode.new).toBe('worktree');
    const current = await session.snapshotter.current();
    expect(session.context).toBe(5);
    expect(current.context).toBe(5);
    expect(current.version).toBe(versions.at(-1));
    await session.close();
  });

  it('coalesces refreshes: at most one waits behind the running one', async () => {
    const slow = gatedRepo();
    const session = new Session(slow.repo, hub, { watch: false, context: 3 });
    await session.start(await session.resolve({ kind: 'revspec', args: ['main..feat'] }));
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

  it('refreshes the worktree snapshot on a dirty signal when only the index changed', async () => {
    // Own repo: `git add -f` and a commit change the index and HEAD that the shared fixture's tests read.
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
      const liveRepo = await GitRepo.open(live);
      const targets: WatchTarget[] = [];
      const watcher = new FakeWatcher(0);
      const session = new Session(liveRepo, hub, {
        watch: true,
        context: 3,
        createWatcher: (target) => {
          targets.push(target);
          return watcher;
        },
      });
      const nextSnapshot = () =>
        new Promise<Snapshot>((resolve) => {
          const off = session.onSnapshot((snap) => {
            off();
            resolve(snap);
          });
        });
      const first = await session.start(await session.resolve({ kind: 'working' }));
      expect(first.changed).toEqual([]);
      expect(first.tree).toEqual(['.gitignore']);
      // Worktree mode watches the worktree with git's ignores; `metaPaths` adds the index to the polled set.
      expect(targets).toHaveLength(1);
      const target = targets[0]!;
      expect(target).toMatchObject({ kind: 'worktree', root: liveRepo.root, gitDir: liveRepo.gitDir });
      if (target.kind !== 'worktree') throw new Error('unreachable');
      expect(target.ignored().has('secret.env')).toBe(true);

      // The file never changed on disk; only the index did.
      let next = nextSnapshot();
      liveGit('add', '-f', 'secret.env');
      watcher.dirty();
      const staged = await next;
      expect(staged.version).toBeGreaterThan(first.version);
      expect(staged.changed.map((f) => f.path)).toEqual(['secret.env']);
      expect(staged.tree).toEqual(['.gitignore', 'secret.env']);

      // HEAD moves without any worktree write.
      next = nextSnapshot();
      liveGit('commit', '-q', '-m', 'force-added');
      watcher.dirty();
      const committed = await next;
      expect(committed.headSha).not.toBe(staged.headSha);
      expect(committed.changed).toEqual([]);
      // close() drains the queue, including the ignore refresh behind each dirty signal: the file is tracked now, so
      // the worktree watcher must stop ignoring it.
      await session.close();
      expect(target.ignored().has('secret.env')).toBe(false);
    } finally {
      await rmTmp(live);
    }
  });

  it('announces moved refs instead of recomputing a refs comparison, until asked to reload', async () => {
    const live = await mkdtemp(join(tmpdir(), 'diffle-refs-'));
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
      await writeFile(join(live, 'a.txt'), 'a\n');
      liveGit('add', '.');
      liveGit('commit', '-q', '-m', 'base');
      liveGit('checkout', '-q', '-b', 'feat');
      await writeFile(join(live, 'a.txt'), 'a\nb\n');
      liveGit('commit', '-q', '-am', 'one');
      const liveRepo = await GitRepo.open(live);
      const watcher = new FakeWatcher(0);
      const messages = () => hub.messages.slice(before);
      const session = new Session(liveRepo, hub, { watch: true, context: 3, createWatcher: () => watcher });
      let published = 0;
      session.onSnapshot(() => published++);
      const first = await session.start(await session.resolve({ kind: 'revspec', args: ['main..feat'] }));
      const before = hub.messages.length;
      expect(first.commits).toMatchObject({ total: 1, oldSha: liveGit('rev-parse', 'main'), newSha: first.newSha });
      expect(session.moved).toBeNull();

      // A commit on the compared branch: the snapshot stands, the clients hear where the ref went.
      await writeFile(join(live, 'a.txt'), 'a\nb\nc\n');
      liveGit('commit', '-q', '-am', 'two');
      const two = liveGit('rev-parse', 'feat');
      watcher.dirty();
      await vi.waitFor(() => expect(session.moved).not.toBeNull());
      expect(session.moved).toEqual({ version: first.version, oldSha: first.oldSha, newSha: two });
      expect(messages()).toEqual([{ type: 'moved', moved: session.moved }]);
      expect(published).toBe(1);
      expect(await session.snapshotter.current()).toBe(first);

      // The same position again says nothing new; `setContext` is a queued no-op that drains the check.
      watcher.dirty();
      await session.setContext(3);
      expect(messages()).toHaveLength(1);

      // Back where the snapshot has it: the notice is withdrawn.
      liveGit('reset', '-q', '--hard', first.newSha);
      watcher.dirty();
      await vi.waitFor(() => expect(session.moved).toBeNull());
      expect(messages()).toEqual([
        { type: 'moved', moved: { version: first.version, oldSha: first.oldSha, newSha: two } },
        { type: 'moved', moved: null },
      ]);

      liveGit('reset', '-q', '--hard', two);
      watcher.dirty();
      await vi.waitFor(() => expect(session.moved).not.toBeNull());
      const reloaded = await session.reload();
      expect(reloaded.version).toBeGreaterThan(first.version);
      expect(reloaded.newSha).toBe(two);
      expect(reloaded.commits.list.map((c) => c.message.trim())).toEqual(['one', 'two']);
      expect(session.moved).toBeNull();
      expect(messages().at(-1)).toEqual({ type: 'snapshot', version: reloaded.version });
      expect(published).toBe(2);
      await session.close();
    } finally {
      await rmTmp(live);
    }
  });

  it('records an iteration per loaded range state and compares two across a rebase', async () => {
    const live = await mkdtemp(join(tmpdir(), 'diffle-iter-'));
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
      await writeFile(join(live, 'a.txt'), 'a\n');
      await writeFile(join(live, 'b.txt'), 'b\n');
      liveGit('add', '.');
      liveGit('commit', '-q', '-m', 'base');
      liveGit('checkout', '-q', '-b', 'feat');
      await writeFile(join(live, 'a.txt'), 'a\nfeature\n');
      liveGit('commit', '-q', '-am', 'feature');
      const liveRepo = await GitRepo.open(live);
      const session = new Session(liveRepo, hub, { watch: false, context: 3 });
      const first = await session.start(await session.resolve({ kind: 'revspec', args: ['main...feat'] }));
      expect(first.iterations).toEqual([
        { n: 1, oldSha: first.oldSha, newSha: first.newSha, recordedAt: expect.any(Number) },
      ]);
      // The pins keep both ends alive whatever happens to the branches.
      const pins = liveGit('for-each-ref', '--format=%(refname) %(objectname)', 'refs/diffle/iterations/');
      expect(
        pins
          .split('\n')
          .map((l) => l.split(' ')[1])
          .sort(),
      ).toEqual([first.oldSha, first.newSha].sort());
      // Reloading the same state records nothing.
      expect((await session.reload()).iterations).toHaveLength(1);

      // Upstream moves on, the branch is rebased onto it and amended.
      liveGit('checkout', '-q', 'main');
      await writeFile(join(live, 'b.txt'), 'b\nupstream\n');
      liveGit('commit', '-q', '-am', 'upstream');
      liveGit('checkout', '-q', 'feat');
      liveGit('rebase', '-q', 'main');
      await writeFile(join(live, 'a.txt'), 'a\nfeature\namended\n');
      liveGit('commit', '-q', '--amend', '--no-edit', '-a');
      const second = await session.reload();
      expect(second.iterations.map((it) => it.n)).toEqual([1, 2]);
      expect(second.iterations[1]).toMatchObject({ oldSha: second.oldSha, newSha: second.newSha });
      // The range itself now also differs from main by the upstream commit's base move, but not in content.
      expect(second.changed.map((f) => f.path)).toEqual(['a.txt']);

      // The interdiff shows the amend alone: b.txt's upstream change is on both sides after the replay.
      const inter = await session.switchMode({ kind: 'interdiff', from: 1, to: 2 });
      expect(inter.mode).toMatchObject({
        new: second.newSha,
        base: 'direct',
        live: 'refs',
        commentKey: `${first.mode.commentKey}:interdiff:1-2`,
        within: first.mode,
        interdiff: { from: second.iterations[0], to: second.iterations[1], conflicts: [] },
      });
      expect(inter.mode.old).not.toBe(first.newSha);
      expect(inter.changed.map((f) => f.path)).toEqual(['a.txt']);
      expect((await session.snapshotter.patch('a.txt'))?.split('\n').filter((l) => /^[+-][^+-]/.test(l))).toEqual([
        '+amended',
      ]);
      expect((await session.readSide(inter, 'b.txt', 'old'))?.toString()).toBe('b\nupstream\n');
      expect(inter.commits.list.map((c) => c.message)).toEqual(['feature']);
      expect(inter.iterations).toHaveLength(2);
      expect(comparisonLabel(inter.mode)).toBe('main...feat #1→#2');

      // A reload from the interdiff returns to the range, where the moved refs would be picked up.
      expect((await session.reload()).mode).toEqual(first.mode);
      await expect(session.switchMode({ kind: 'interdiff', from: 2, to: 1 })).rejects.toThrow(RevspecError);
      await expect(session.switchMode({ kind: 'interdiff', from: 1, to: 3 })).rejects.toThrow(RevspecError);
      await session.close();
    } finally {
      await rmTmp(live);
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
    await session.start(await session.resolve({ kind: 'revspec', args: ['main..feat'] }));
    const a = session.switchMode({ kind: 'working' });
    const b = session.switchMode({ kind: 'revspec', args: ['main'] });
    const [snapA, snapB] = await Promise.all([a, b]);
    expect(snapB.version).toBeGreaterThan(snapA.version);
    expect(session.mode).toMatchObject({ old: 'main', new: 'HEAD', base: 'merge-base' });
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
  private readonly listeners: (() => void)[] = [];
  constructor(private readonly startDelay: number) {}
  on(_event: 'dirty', listener: () => void): this {
    this.listeners.push(listener);
    return this;
  }
  /** What the debounced fs events would have produced. */
  dirty(): void {
    for (const l of this.listeners) l();
  }
  async start(): Promise<void> {
    await new Promise((r) => setTimeout(r, this.startDelay));
    this.state = 'open';
  }
  async close(): Promise<void> {
    this.state = 'closed';
  }
}

describe('old-side worktree reads', () => {
  it('maps reverse rename anchors into the worktree and preserves the new-side allowlist', async () => {
    const session = new Session(repo, hub, { watch: false, context: 3 });
    try {
      const snap = await session.start(await session.resolve({ kind: 'revspec', args: ['worktree..main'] }));
      const renamed = snap.changed.find((file) => file.path === 'old.txt')!;
      expect(renamed.oldPath).toBe('new.txt');
      expect((await session.readSide(snap, 'old.txt', 'old'))?.toString()).toBe('alpha\nbeta\ngamma\ndelta\n');
      expect((await session.readSide(snap, 'old.txt', 'new'))?.toString()).toBe('alpha\nbeta\ngamma\n');
      expect(await session.readSide(snap, 'secret.env', 'old')).toBeNull();
      expect(await session.readSide(snap, 'new.txt', 'new')).toBeNull();
    } finally {
      await session.close();
    }
  });
});
