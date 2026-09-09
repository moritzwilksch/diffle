import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rmTmp } from '../tmp.js';
import { BIG_FILE_THRESHOLD, GitRepo } from '../../src/server/git/GitRepo.js';
import { SNIFF_BYTES } from '../../src/server/generated.js';
import { resolveMode } from '../../src/server/mode.js';
import { Snapshotter } from '../../src/server/Snapshotter.js';

// Windows rejects `\n` in a filename, so those fixtures only exist on POSIX.
const NEWLINE_NAMES = process.platform !== 'win32';

let dir: string;
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

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'diffle-git-'));
  git('init', '-q', '-b', 'main');
  await writeFile(join(dir, 'a.txt'), 'one\ntwo\n');
  await writeFile(join(dir, 'keep.txt'), 'k\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feat');
  await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  await writeFile(join(dir, 'new.txt'), 'n\n');
  git('add', '.');
  git('commit', '-q', '-m', 'feat 1');
  git('checkout', '-q', 'main');
  await writeFile(join(dir, 'keep.txt'), 'k2\n');
  git('commit', '-q', '-am', 'main moves on');
  git('checkout', '-q', 'feat');
  // Uncommitted: modify + untracked + delete.
  await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n');
  await writeFile(join(dir, 'untracked.txt'), 'u\n');
  await writeFile(join(dir, '.gitignore'), 'ignored.txt\n');
  await writeFile(join(dir, 'ignored.txt'), 'i\n');
  repo = await GitRepo.open(join(dir));
});
afterAll(() => rmTmp(dir));

describe('GitRepo', () => {
  it('opens from a subdirectory path and resolves root/gitDir', async () => {
    expect(repo.root).toBe(await realpath(dir));
    expect(repo.gitDir).toBe(join(await realpath(dir), '.git'));
    expect(repo.commonDir).toBe(repo.gitDir);
  });

  it('lists tracked and untracked files, honoring .gitignore', async () => {
    expect(await repo.lsFiles()).toEqual(['a.txt', 'keep.txt', 'new.txt']);
    expect(await repo.untracked()).toEqual(['.gitignore', 'untracked.txt']);
    expect(await repo.ignoredPaths()).toEqual(['ignored.txt']);
  });

  it('numstat against the worktree includes untracked files as added', async () => {
    const files = await repo.numstat('HEAD', 'worktree');
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ['.gitignore', 'A', 1, 0],
      ['a.txt', 'M', 1, 0],
      ['untracked.txt', 'A', 1, 0],
    ]);
    expect(files.every((f) => f.blob.length === 40)).toBe(true);
  });

  it('numstat between revs carries the new-side blob', async () => {
    const mb = await repo.mergeBase('main', 'feat');
    const files = await repo.numstat(mb, 'feat');
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ['a.txt', 'M', 1, 0],
      ['new.txt', 'A', 1, 0],
    ]);
    expect(files.map((f) => f.blob)).toEqual([git('rev-parse', 'feat:a.txt'), git('rev-parse', 'feat:new.txt')]);
  });

  it('numstat reports renames and binaries', async () => {
    await writeFile(join(dir, 'bin.dat'), Buffer.from([0, 1, 2]));
    git('mv', 'keep.txt', 'moved.txt');
    try {
      const files = await repo.numstat('HEAD', 'worktree');
      const byPath = new Map(files.map((f) => [f.path, f]));
      expect(byPath.get('moved.txt')).toMatchObject({ status: 'R', oldPath: 'keep.txt', additions: 0, deletions: 0 });
      expect(byPath.get('bin.dat')).toMatchObject({ status: 'A', binary: true, additions: 0 });
      expect(byPath.get('a.txt')?.blob).toBe(git('hash-object', '--', 'a.txt'));
      expect(files.every((f) => f.status === 'D' || f.blob.length === 40)).toBe(true);
    } finally {
      git('mv', 'moved.txt', 'keep.txt');
      await rm(join(dir, 'bin.dat'));
    }
  });

  it.skipIf(!NEWLINE_NAMES)('numstat reports a path containing a newline', async () => {
    const odd = 'odd\nname.txt';
    await writeFile(join(dir, odd), 'odd\n');
    try {
      const files = await repo.numstat('HEAD', 'worktree');
      const byPath = new Map(files.map((f) => [f.path, f]));
      expect(byPath.get(odd)).toMatchObject({ status: 'A', additions: 1, blob: git('hash-object', '--', odd) });
    } finally {
      await rm(join(dir, odd));
    }
  });

  it('treats option-shaped revisions as names, not git options', async () => {
    await expect(repo.resolve('--all')).rejects.toThrow();
    await expect(repo.resolve('--output=/tmp/x')).rejects.toThrow();
    await expect(repo.mergeBase('--all', 'HEAD')).rejects.toThrow();
  });

  it('produces a parseable patch for tracked and untracked files', async () => {
    const files = await repo.numstat('HEAD', 'worktree');
    const a = await repo.patch('HEAD', 'worktree', files.find((f) => f.path === 'a.txt')!);
    expect(a).toContain('diff --git a/a.txt b/a.txt');
    expect(a).toContain('+four');
    const u = await repo.patch('HEAD', 'worktree', files.find((f) => f.path === 'untracked.txt')!);
    expect(u).toContain('diff --git a/untracked.txt b/untracked.txt');
    expect(u).toContain('+++ b/untracked.txt');
    const all = await repo.patchAll('HEAD', 'worktree', files);
    expect(all).toContain('b/a.txt');
    expect(all).toContain('b/untracked.txt');
  });

  it('patchMany covers tracked and untracked files and nothing else', async () => {
    const files = await repo.numstat('HEAD', 'worktree');
    const pick = (...ps: string[]) => files.filter((f) => ps.includes(f.path));
    const both = await repo.patchMany('HEAD', 'worktree', pick('a.txt', 'untracked.txt'));
    expect(both).toContain('+++ b/a.txt');
    expect(both).toContain('+++ b/untracked.txt');
    expect(await repo.patchMany('HEAD', 'worktree', pick('untracked.txt'))).not.toContain('a.txt');
    expect(await repo.patchMany('HEAD', 'worktree', [])).toBe('');
  });

  it('honours a known untracked flag instead of probing the index', async () => {
    const files = await repo.numstat('HEAD', 'worktree');
    const u = files.find((f) => f.path === 'untracked.txt')!;
    expect(await repo.patch('HEAD', 'worktree', u, 3, true)).toContain('+++ b/untracked.txt');
    // Told it is tracked, the patch goes through `diff HEAD --`, which has nothing for an untracked path.
    expect(await repo.patch('HEAD', 'worktree', u, 3, false)).toBe('');
  });

  // Windows has no sparse `truncate`, so half a gigabyte is really written: well over the default budget.
  it('marks an untracked file at the big-file threshold binary without reading it', async () => {
    // Sparse where the filesystem allows it: the size is what matters, not the bytes.
    const fh = await open(join(dir, 'huge.bin'), 'w');
    await fh.truncate(BIG_FILE_THRESHOLD);
    await fh.close();
    try {
      const files = await repo.numstat('HEAD', 'worktree');
      expect(files.find((f) => f.path === 'huge.bin')).toMatchObject({ status: 'A', binary: true, additions: 0 });
      expect(await repo.patchAll('HEAD', 'worktree', files)).not.toContain('huge.bin');
    } finally {
      await rm(join(dir, 'huge.bin'));
    }
  }, 60_000);

  it('reads either side and refuses path traversal', async () => {
    expect((await repo.show('HEAD', 'a.txt'))?.toString()).toBe('one\ntwo\nthree\n');
    expect(await repo.show('HEAD', 'missing.txt')).toBeNull();
    expect((await repo.readWorktree('a.txt'))?.toString()).toBe('one\ntwo\nthree\nfour\n');
    expect(await repo.readWorktree('../etc/passwd')).toBeNull();
  });

  it('lists a commit tree', async () => {
    expect(await repo.lsTree('main')).toEqual(['a.txt', 'keep.txt']);
    expect(await repo.lsTree('feat')).toEqual(['a.txt', 'keep.txt', 'new.txt']);
  });

  it('bounds search results globally and flags truncation only when more exist', async () => {
    const all = await repo.grep('o', 'worktree', 50);
    expect(all.matches.length).toBeGreaterThanOrEqual(3);
    expect(all.truncated).toBe(false);
    const exact = await repo.grep('o', 'worktree', all.matches.length);
    expect(exact.matches).toEqual(all.matches);
    expect(exact.truncated).toBe(false);
    const cut = await repo.grep('o', 'worktree', 2);
    expect(cut.matches).toEqual(all.matches.slice(0, 2));
    expect(cut.truncated).toBe(true);
  });

  it('whole-word search matches complete, case-sensitive words only', async () => {
    const word = await repo.grep('one', 'worktree', 50, { word: true });
    expect(word.matches.map((m) => [m.path, m.line])).toEqual([['a.txt', 1]]);
    expect((await repo.grep('on', 'worktree', 50, { word: true })).matches).toEqual([]);
    expect((await repo.grep('on', 'worktree', 50)).matches.length).toBeGreaterThan(0);
    expect((await repo.grep('ONE', 'worktree', 50, { word: true })).matches).toEqual([]);
  });

  it('text search is case-sensitive unless asked otherwise, and can take an extended regex', async () => {
    expect((await repo.grep('ONE', 'worktree', 50)).matches).toEqual([]);
    expect((await repo.grep('ONE', 'worktree', 50, { ignoreCase: true })).matches.map((m) => m.path)).toEqual(['a.txt']);
    expect((await repo.grep('t(wo|hree)', 'worktree', 50)).matches).toEqual([]);
    expect((await repo.grep('t(wo|hree)', 'worktree', 50, { regex: true })).matches.map((m) => m.line)).toEqual([2, 3]);
  });

  it('restricts a search to the given paths literally, and an empty list matches nothing', async () => {
    expect((await repo.grep('o', 'worktree', 50, { paths: ['a.txt'] })).matches.every((m) => m.path === 'a.txt')).toBe(true);
    expect((await repo.grep('o', 'worktree', 50, { paths: ['a.txt'] })).matches.length).toBeGreaterThan(0);
    expect((await repo.grep('o', 'worktree', 50, { paths: [] })).matches).toEqual([]);
    // `*` is a literal character, not a glob, so it selects no file.
    expect((await repo.grep('o', 'worktree', 50, { paths: ['*.txt'] })).matches).toEqual([]);
    expect((await repo.grep('one', 'feat', 50, { paths: ['a.txt'] })).matches.map((m) => m.path)).toEqual(['a.txt']);
  });

  it('lists refs', async () => {
    const refs = await repo.refs();
    expect(refs.current).toBe('feat');
    expect(refs.branches.sort()).toEqual(['feat', 'main']);
    expect(refs.recent[0]?.subject).toBe('feat 1');
  });

  it('lists refs on an unborn branch instead of failing', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'diffle-empty-'));
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: empty });
      const refs = await (await GitRepo.open(empty)).refs();
      expect(refs).toMatchObject({ branches: [], recent: [], current: null });
    } finally {
      await rmTmp(empty);
    }
  });
});

describe('GitRepo under hostile config', () => {
  let hostile: string;
  let hrepo: GitRepo;
  const hgit = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: hostile,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' },
    }).trim();

  beforeAll(async () => {
    hostile = await mkdtemp(join(tmpdir(), 'diffle-hostile-'));
    hgit('init', '-q', '-b', 'main');
    // Repo-local stand-ins for the ~/.gitconfig settings that break the patch parser.
    hgit('config', 'diff.noprefix', 'true');
    hgit('config', 'diff.mnemonicPrefix', 'true');
    hgit('config', 'diff.external', '/bin/false');
    hgit('config', 'color.ui', 'always');
    // Per-command colour settings win over color.ui, so pin them separately.
    hgit('config', 'color.diff', 'always');
    hgit('config', 'color.grep', 'always');
    hgit('config', 'grep.column', 'true');
    hgit('config', 'core.quotePath', 'true');
    await writeFile(join(hostile, 'ä.txt'), 'eins\n');
    await writeFile(join(hostile, 'plain.txt'), 'p\n');
    hgit('add', '.');
    hgit('commit', '-q', '-m', 'base');
    await writeFile(join(hostile, 'ä.txt'), 'eins\nzwei\n');
    hgit('commit', '-q', '-am', 'edit');
    await writeFile(join(hostile, 'ä.txt'), 'eins\nzwei\ndrei\n');
    await writeFile(join(hostile, 'ü.txt'), 'neu\n');
    hrepo = await GitRepo.open(hostile);
  });
  afterAll(() => rmTmp(hostile));

  it('ignores diff prefix, external diff and colour settings in patches', async () => {
    const files = await hrepo.numstat('HEAD~1', 'HEAD');
    expect(files.map((f) => f.path)).toEqual(['ä.txt']);
    const p = await hrepo.patch('HEAD~1', 'HEAD', files[0]!);
    expect(p).toContain('diff --git a/ä.txt b/ä.txt\n');
    expect(p).toContain('+++ b/ä.txt\n');
    expect(p).toContain('+zwei');
    expect(p).not.toContain('\u001b[');
    expect(await hrepo.patchAll('HEAD~1', 'HEAD', files)).toBe(p);
  });

  it('names non-ASCII paths verbatim in worktree patches, including untracked files', async () => {
    const files = await hrepo.numstat('HEAD', 'worktree');
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['ä.txt', 'M'],
      ['ü.txt', 'A'],
    ]);
    const u = await hrepo.patch('HEAD', 'worktree', files[1]!);
    expect(u).toContain('diff --git a/ü.txt b/ü.txt\n');
    expect(u).toContain('+++ b/ü.txt\n');
    const all = await hrepo.patchAll('HEAD', 'worktree', files);
    expect(all).toContain('diff --git a/ä.txt b/ä.txt\n');
    expect(all).toContain('diff --git a/ü.txt b/ü.txt\n');
    expect(all).not.toContain('\\303');
    expect(all).not.toContain('\u001b[');
  });

  // Windows forbids `"` in a filename, so the quoting path is only reachable on POSIX.
  it.skipIf(process.platform === 'win32')('mirrors the quoting of the new side when rewriting the /dev/null header', async () => {
    const quoted = 'qu"ote.txt';
    await writeFile(join(hostile, quoted), 'q\n');
    try {
      const file = (await hrepo.numstat('HEAD', 'worktree')).find((f) => f.path === quoted)!;
      const p = await hrepo.patch('HEAD', 'worktree', file);
      expect(p).toContain('diff --git "a/qu\\"ote.txt" "b/qu\\"ote.txt"\n');
      expect(p).not.toContain('dev/null b/');
    } finally {
      await rm(join(hostile, quoted));
    }
  });

  it('searches without colour escapes or a column field', async () => {
    const hits = await hrepo.grep('zwei', 'worktree', 10);
    expect(hits.matches).toEqual([{ path: 'ä.txt', line: 2, text: 'zwei' }]);
    const committed = await hrepo.grep('zwei', 'HEAD', 10);
    expect(committed.matches).toEqual([{ path: 'ä.txt', line: 2, text: 'zwei' }]);
  });
});

describe('GitRepo on a worktree with a submodule, a broken symlink and a nested repo', () => {
  let base: string;
  let sup: string;
  let srepo: GitRepo;
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' };
  const sgit = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim();

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'diffle-sub-'));
    const lib = join(base, 'lib');
    sup = join(base, 'super');
    await mkdir(lib);
    await mkdir(sup);
    sgit(lib, 'init', '-q', '-b', 'main');
    await writeFile(join(lib, 'l.txt'), 'one\n');
    sgit(lib, 'add', '.');
    sgit(lib, 'commit', '-q', '-m', 'lib base');
    sgit(sup, 'init', '-q', '-b', 'main');
    await writeFile(join(sup, 'a.txt'), 'a\n');
    sgit(sup, 'add', '.');
    sgit(sup, 'commit', '-q', '-m', 'base');
    sgit(sup, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '../lib', 'sub');
    sgit(sup, 'commit', '-q', '-m', 'add sub');
    // The submodule moves to a commit the superproject has not recorded.
    await writeFile(join(sup, 'sub', 'l.txt'), 'one\ntwo\n');
    sgit(join(sup, 'sub'), 'commit', '-q', '-am', 'bump');
    // Alongside: an ordinary edit, a staged broken symlink, an untracked nested repository.
    await writeFile(join(sup, 'a.txt'), 'a\nb\n');
    await symlink('nowhere', join(sup, 'broken.lnk'));
    sgit(sup, 'add', 'broken.lnk');
    await mkdir(join(sup, 'nested'));
    sgit(join(sup, 'nested'), 'init', '-q');
    await writeFile(join(sup, 'nested', 'n.txt'), 'n\n');
    srepo = await GitRepo.open(sup);
  });
  afterAll(() => rmTmp(base));

  it('numstat still loads every ordinary file and marks the gitlink', async () => {
    const files = await srepo.numstat('HEAD', 'worktree');
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ['a.txt', 'M', 1, 0],
      ['broken.lnk', 'A', 1, 0],
      ['sub', 'M', 1, 1],
    ]);
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(byPath.get('a.txt')).toMatchObject({ blob: sgit(sup, 'hash-object', '--', 'a.txt') });
    expect(byPath.get('a.txt')!.submodule).toBeUndefined();
    // A symlink's blob is its target string, the same sha the index holds.
    expect(byPath.get('broken.lnk')!.blob).toBe(sgit(sup, 'ls-files', '-s', 'broken.lnk').split(/\s+/)[1]);
    // The gitlink's "blob" is the commit the submodule is checked out at.
    expect(byPath.get('sub')).toMatchObject({ submodule: true, blob: sgit(join(sup, 'sub'), 'rev-parse', 'HEAD') });
  });

  it('marks a gitlink when diffing two commits too', async () => {
    const files = await srepo.numstat('HEAD~1', 'HEAD');
    expect(files.map((f) => [f.path, f.status, f.submodule])).toEqual([
      ['.gitmodules', 'A', undefined],
      ['sub', 'A', true],
    ]);
  });

  it('renders a gitlink as a commit-id change and leaves it out of hydration and sniffing', async () => {
    const mode = await resolveMode({ kind: 'working' }, srepo);
    const snapshotter = new Snapshotter(srepo, mode, 1, 3);
    const snap = await snapshotter.current();
    expect(snap.changed.map((f) => f.path)).toEqual(['a.txt', 'broken.lnk', 'sub']);
    expect(snap.tree).toContain('sub');
    expect(snap.tree.some((p) => p.startsWith('nested'))).toBe(false);
    expect(snap.changed.find((f) => f.path === 'sub')).toMatchObject({ submodule: true, generated: false });
    const patch = await snapshotter.patch('sub');
    expect(patch).toContain('-Subproject commit ');
    expect(patch).toContain('+Subproject commit ');
    expect(await snapshotter.patchAll()).toContain('+b\n');
    // Not a file on either side: the read reports absence instead of throwing.
    expect(await srepo.readWorktree('sub')).toBeNull();
  });

  // `chmod 0` only sets the read-only bit on Windows, so nothing there makes the read fail.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('an unreadable file keeps an empty blob without failing the batch', async () => {
    await writeFile(join(sup, 'locked.txt'), 'x\n');
    await chmod(join(sup, 'locked.txt'), 0o000);
    try {
      const files = await srepo.numstat('HEAD', 'worktree');
      const byPath = new Map(files.map((f) => [f.path, f]));
      expect(byPath.get('locked.txt')).toMatchObject({ status: 'A', blob: '' });
      expect(byPath.get('a.txt')!.blob).toBe(sgit(sup, 'hash-object', '--', 'a.txt'));
    } finally {
      await chmod(join(sup, 'locked.txt'), 0o644);
      await rm(join(sup, 'locked.txt'));
    }
  });
});

describe('resolveMode + Snapshotter', () => {
  it('branch mode diffs merge-base against HEAD and keys comments by merge-base', async () => {
    const mode = await resolveMode({ kind: 'branch', base: 'main' }, repo);
    const mb = await repo.mergeBase('main', 'feat');
    expect(mode.commentKey).toBe(`branch:${mb}`);
    expect(mode.live).toBe('refs');
    const snap = await new Snapshotter(repo, mode, 1, 3).current();
    expect(snap.oldSha).toBe(mb);
    expect(snap.changed.map((f) => f.path)).toEqual(['a.txt', 'new.txt']);
    expect(snap.tree).toEqual(['a.txt', 'keep.txt', 'new.txt']);
  });

  it('the tree belongs to the selected new revision, not the checked-out index', async () => {
    // Index (feat) has new.txt; main does not.
    const mode = await resolveMode({ kind: 'revspec', args: ['feat..main'] }, repo);
    const snap = await new Snapshotter(repo, mode, 1, 3).current();
    expect(snap.tree).toEqual(['a.txt', 'keep.txt']);
    expect(snap.changed.map((f) => [f.path, f.status])).toEqual([
      ['a.txt', 'M'],
      ['keep.txt', 'M'],
      ['new.txt', 'D'],
    ]);
  });

  it('working mode is live on the worktree', async () => {
    const mode = await resolveMode({ kind: 'working' }, repo);
    expect(mode.live).toBe('worktree');
    const snap = await new Snapshotter(repo, mode, 1, 3).current();
    expect(snap.newSha).toBe('worktree');
    expect(snap.tree).toContain('untracked.txt');
    expect(snap.tree).not.toContain('ignored.txt');
  });

  it('revspec: pinned shas are static, symbolic refs are live', async () => {
    const sha = await repo.resolve('main');
    expect((await resolveMode({ kind: 'revspec', args: [`${sha}..${sha}`] }, repo)).live).toBe('none');
    expect((await resolveMode({ kind: 'revspec', args: ['main..feat'] }, repo)).live).toBe('refs');
    expect((await resolveMode({ kind: 'revspec', args: ['main'] }, repo)).live).toBe('worktree');
  });
});

describe('working mode on an unborn branch', () => {
  let fresh: string;
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' };
  beforeAll(async () => {
    fresh = await mkdtemp(join(tmpdir(), 'diffle-unborn-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: fresh, env });
    await writeFile(join(fresh, 'staged.txt'), 's1\ns2\n');
    execFileSync('git', ['add', 'staged.txt'], { cwd: fresh, env });
    await writeFile(join(fresh, 'loose.txt'), 'l\n');
  });
  afterAll(() => rmTmp(fresh));

  it('diffs the worktree against the empty tree instead of failing on HEAD', async () => {
    const urepo = await GitRepo.open(fresh);
    const mode = await resolveMode({ kind: 'working' }, urepo);
    const snapshotter = new Snapshotter(urepo, mode, 1, 3);
    const snap = await snapshotter.current();
    expect(snap.oldSha).toBe(await urepo.emptyTree());
    expect(snap.headSha).toBe('');
    expect(snap.changed.map((f) => [f.path, f.status, f.additions])).toEqual([
      ['loose.txt', 'A', 1],
      ['staged.txt', 'A', 2],
    ]);
    expect(snap.tree).toEqual(['loose.txt', 'staged.txt']);
    expect(await snapshotter.patch('staged.txt')).toContain('+s2\n');
    expect(await snapshotter.patchAll()).toContain('+l\n');
  });

  it('still reports an unknown revision as a revspec error', async () => {
    const urepo = await GitRepo.open(fresh);
    await expect(resolveMode({ kind: 'revspec', args: ['HEAD'] }, urepo)).rejects.toThrow('unknown revision: HEAD');
  });
});

async function realpath(p: string): Promise<string> {
  const { realpath } = await import('node:fs/promises');
  return realpath(p);
}

describe('cat-file batch', () => {
  let bdir: string;
  let brepo: GitRepo;
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' };
  const bgit = (...args: string[]) => execFileSync('git', args, { cwd: bdir, encoding: 'utf8', env }).trim();
  const odd = 'odd\nname.txt';

  beforeAll(async () => {
    bdir = await mkdtemp(join(tmpdir(), 'diffle-batch-'));
    bgit('init', '-q', '-b', 'main');
    await writeFile(join(bdir, 'small.txt'), 'one\ntwo\n');
    // Large, textual, no generated marker: the sniff must not read it whole.
    await writeFile(join(bdir, 'big.txt'), 'x'.repeat(200_000) + '\n');
    if (NEWLINE_NAMES) await writeFile(join(bdir, odd), 'odd\n');
    await writeFile(join(bdir, 'has space.txt'), 'sp\n');
    await mkdir(join(bdir, 'dir'));
    await writeFile(join(bdir, 'dir', 'in.txt'), 'in\n');
    bgit('add', '.');
    bgit('commit', '-q', '-m', 'base');
    bgit('checkout', '-q', '-b', 'feat');
    await writeFile(join(bdir, 'small.txt'), 'one\ntwo\nthree\n');
    await writeFile(join(bdir, 'gen.py'), '# @generated by tool\nx = 1\n');
    bgit('add', '.');
    bgit('commit', '-q', '-m', 'feat');
    brepo = await GitRepo.open(bdir);
  });
  afterAll(() => rmTmp(bdir));

  it('answers a list of blob shas from one process, keeping only a prefix of each', async () => {
    const shas = [bgit('rev-parse', 'HEAD:small.txt'), bgit('rev-parse', 'HEAD:big.txt'), '0'.repeat(40), bgit('rev-parse', 'HEAD:dir')];
    const before = brepo.catFileSpawns;
    const heads = await brepo.blobHeads(shas, 16);
    expect(brepo.catFileSpawns).toBe(before + 1);
    expect(heads.get(shas[0]!)?.toString()).toBe('one\ntwo\nthree\n');
    expect(heads.get(shas[1]!)?.length).toBe(16);
    // Missing objects and non-blobs (a tree) are left out rather than failing the batch.
    expect(heads.has(shas[2]!)).toBe(false);
    expect(heads.has(shas[3]!)).toBe(false);
    // Concurrent readers share the process; answers stay matched to their names.
    const many = await Promise.all(Array.from({ length: 40 }, (_, i) => brepo.head('HEAD', i % 2 ? 'small.txt' : 'big.txt', 4)));
    expect(many.map((b) => b?.toString())).toEqual(Array.from({ length: 40 }, (_, i) => (i % 2 ? 'one\n' : 'xxxx')));
    expect(brepo.catFileSpawns).toBe(before + 1);
  });

  it('show reads whole blobs through the same process and reports non-blobs as absent', async () => {
    const before = brepo.catFileSpawns;
    const bodies = await Promise.all(Array.from({ length: 300 }, (_, i) => brepo.show('HEAD', ['small.txt', 'big.txt', 'dir/in.txt'][i % 3]!)));
    expect(bodies.map((b) => b?.length)).toEqual(Array.from({ length: 300 }, (_, i) => [14, 200_001, 3][i % 3]));
    // At most one new process: none when the previous test's is still within its idle grace.
    expect(brepo.catFileSpawns - before).toBeLessThanOrEqual(1);
    expect(await brepo.show('HEAD', 'dir')).toBeNull();
    expect(await brepo.show('HEAD', 'nope.txt')).toBeNull();
    expect(await brepo.show('0'.repeat(40), 'small.txt')).toBeNull();
  });

  it('head on a commit resolves paths and reports non-files as absent', async () => {
    expect((await brepo.head('HEAD', 'small.txt', 3))?.toString()).toBe('one');
    expect(await brepo.head('HEAD', 'missing.txt', 10)).toBeNull();
    expect(await brepo.head('HEAD', 'dir', 10)).toBeNull();
  });

  // A name with a newline cannot ride the batch, so both reads fall back to a plain cat-file.
  it.skipIf(!NEWLINE_NAMES)('reads a path containing a newline beside the batch', async () => {
    expect((await brepo.show('HEAD', odd))?.toString()).toBe('odd\n');
    expect((await brepo.head('HEAD', odd, 100))?.toString()).toBe('odd\n');
  });

  it('the snapshot sniffs each blob once across refreshes and only new blobs after a commit', async () => {
    const mode = await resolveMode({ kind: 'revspec', args: ['main..feat'] }, brepo);
    const snapshotter = new Snapshotter(brepo, mode, 1, 3);
    const spy = vi.spyOn(brepo, 'blobHeads');
    const first = await snapshotter.current();
    expect(Object.fromEntries(first.changed.map((f) => [f.path, f.generated]))).toEqual({ 'gen.py': true, 'small.txt': false });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0].sort()).toEqual([bgit('rev-parse', 'feat:gen.py'), bgit('rev-parse', 'feat:small.txt')].sort());
    expect(spy.mock.calls[0]![1]).toBe(SNIFF_BYTES);
    // Same blobs: the verdicts come from the cache.
    snapshotter.invalidate(2);
    const second = await snapshotter.current();
    expect(second.changed.map((f) => f.generated)).toEqual(first.changed.map((f) => f.generated));
    expect(spy).toHaveBeenLastCalledWith([], SNIFF_BYTES);
    // One more edit: only its blob is read.
    await writeFile(join(bdir, 'small.txt'), '# DO NOT EDIT\nfour\n');
    bgit('commit', '-q', '-am', 'more');
    snapshotter.invalidate(3);
    const third = await snapshotter.current();
    expect(third.changed.find((f) => f.path === 'small.txt')?.generated).toBe(true);
    expect(spy).toHaveBeenLastCalledWith([bgit('rev-parse', 'feat:small.txt')], SNIFF_BYTES);
  });

  it('reports a missing name that contains a space as null without stalling the batch', async () => {
    expect((await brepo.show('HEAD', 'has space.txt'))?.toString()).toBe('sp\n');
    expect(await brepo.show('HEAD', 'no such.txt')).toBeNull();
    expect(await brepo.head('HEAD', 'also missing.txt', 4)).toBeNull();
    expect((await brepo.show('main', 'small.txt'))?.toString()).toBe('one\ntwo\n');
  });
});
