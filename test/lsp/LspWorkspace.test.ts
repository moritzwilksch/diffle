import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { rmTmp } from '../tmp.js';
import { GitError, GitRepo } from '../../src/server/git/GitRepo.js';
import { LspWorkspace } from '../../src/server/lsp/LspWorkspace.js';

let dir: string;
let repo: GitRepo;
let first: string;
let second: string;
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
/** Worktree directories git knows, the repository's own first. Git prints real paths; macOS's temp dir is a symlink. */
const worktrees = async () =>
  Promise.all(
    git('worktree', 'list', '--porcelain')
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => realpath(l.slice('worktree '.length)).catch(() => l.slice('worktree '.length))),
  );
const real = (...paths: string[]) => Promise.all(paths.map((p) => realpath(p)));
const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'diffle-lsp-ws-'));
  git('init', '-q', '-b', 'main');
  await writeFile(join(dir, 'a.py'), 'x = 1\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  first = git('rev-parse', 'HEAD');
  await writeFile(join(dir, 'a.py'), 'x = 2\n');
  await writeFile(join(dir, 'b.py'), 'y = 1\n');
  git('add', '.');
  git('commit', '-q', '-m', 'second');
  second = git('rev-parse', 'HEAD');
  repo = await GitRepo.open(dir);
});
afterAll(async () => {
  await rmTmp(dir);
});

const open: LspWorkspace[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((w) => w.close()));
});
function workspace(opts?: ConstructorParameters<typeof LspWorkspace>[1]): LspWorkspace {
  const w = new LspWorkspace(repo, opts);
  open.push(w);
  return w;
}

describe('LspWorkspace', () => {
  it('serves the checkout from the repository itself, without a worktree', async () => {
    const w = workspace();
    expect(await w.rootFor({ newSha: 'worktree', headSha: second })).toBe(repo.root);
    expect(await w.rootFor({ newSha: second, headSha: second })).toBe(repo.root);
    expect(w.dir).toBeNull();
    expect(await worktrees()).toEqual(await real(repo.root));
  });

  it('checks any other commit out into a detached worktree and moves it with the snapshot', async () => {
    const created: string[] = [];
    const w = workspace({ onCreate: (d) => created.push(d) });
    const root = await w.rootFor({ newSha: first, headSha: second });
    expect(root).not.toBe(repo.root);
    expect(root).toBe(w.dir);
    expect(created).toEqual([root]);
    expect(await readFile(join(root, 'a.py'), 'utf8')).toBe('x = 1\n');
    expect(await exists(join(root, 'b.py'))).toBe(false);
    expect(await worktrees()).toEqual(await real(repo.root, root));
    // The user's checkout is where it was.
    expect(git('rev-parse', 'HEAD')).toBe(second);
    expect(await readFile(join(dir, 'a.py'), 'utf8')).toBe('x = 2\n');

    // Another commit reuses the directory; a run of requests lands on the last one asked for.
    const roots = await Promise.all([
      w.rootFor({ newSha: second, headSha: 'worktree' }),
      w.rootFor({ newSha: first, headSha: 'worktree' }),
      w.rootFor({ newSha: second, headSha: 'worktree' }),
    ]);
    expect(roots).toEqual([root, root, root]);
    expect(created).toHaveLength(1);
    expect(await readFile(join(root, 'a.py'), 'utf8')).toBe('x = 2\n');
    expect(await exists(join(root, 'b.py'))).toBe(true);

    await w.close();
    expect(await exists(root)).toBe(false);
    expect(await worktrees()).toEqual(await real(repo.root));
    await expect(w.rootFor({ newSha: first, headSha: second })).rejects.toThrow(/shutting down/);
  });

  it('leaves nothing behind when the checkout fails, and prunes what a killed run left', async () => {
    // A worktree whose directory vanished, as after a kill: git refuses nothing, but the entry lingers.
    const stale = await mkdtemp(join(tmpdir(), 'diffle-lsp-stale-'));
    await rm(stale, { recursive: true });
    git('worktree', 'add', '--detach', '--quiet', stale, first);
    await rm(stale, { recursive: true, force: true });
    expect(await worktrees()).toHaveLength(2);

    const w = workspace();
    await expect(w.rootFor({ newSha: 'f'.repeat(40), headSha: second })).rejects.toThrow(GitError);
    expect(w.dir).toBeNull();
    // The failed attempt pruned the stale entry on its way and left no directory of its own.
    expect(await worktrees()).toEqual(await real(repo.root));
    const root = await w.rootFor({ newSha: first, headSha: second });
    expect(await readFile(join(root, 'a.py'), 'utf8')).toBe('x = 1\n');
  });
});
