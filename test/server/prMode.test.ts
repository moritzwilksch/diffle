import { execFileSync, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmTmp } from '../tmp.js';
import { openReviewRepository } from '../../src/cli/repository.js';
import { GitRepo } from '../../src/server/git/GitRepo.js';
import { GithubError, viewPr, type GhRunner } from '../../src/server/github.js';
import { resolveMode } from '../../src/server/mode.js';

/** macOS reaches `os.tmpdir()` through a symlink (`/var` → `/private/var`); git reports the physical path. */
const TMP_ROOT = realpathSync(tmpdir());

let tmp: string;
/** Bare "GitHub": holds refs/pull/7/head. Its path ends in o/r so it matches the PR url's slug. */
let origin: string;
let local: string;
let repo: GitRepo;
let headSha: string;
let mergeBase: string;

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim();

/**
 * A local path as git sees a URL. Windows separators would be escapes inside a
 * config value, and `remoteSlug` splits on `/`, so a `\` path never matches a slug.
 */
const asGitUrl = (p: string) => p.replaceAll('\\', '/');

/** What `gh pr view` would say for PR 7 of o/r. */
const PR_VIEW = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    number: 7,
    url: 'https://github.com/o/r/pull/7',
    baseRefName: 'main',
    headRefName: 'feat',
    headRefOid: 'unused-here',
    ...over,
  });

let ghCalls: string[][] = [];
const gh: GhRunner = async (args) => {
  ghCalls.push(args);
  return PR_VIEW();
};

beforeAll(async () => {
  tmp = await mkdtemp(join(TMP_ROOT, 'diffle-pr-'));
  origin = join(tmp, 'o', 'r');
  await mkdir(origin, { recursive: true });
  git(origin, 'init', '-q', '-b', 'main');
  await writeFile(join(origin, 'a.txt'), 'one\n');
  git(origin, 'add', '.');
  git(origin, 'commit', '-q', '-m', 'base');
  mergeBase = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'checkout', '-q', '-b', 'feat');
  await writeFile(join(origin, 'a.txt'), 'one\ntwo\n');
  git(origin, 'commit', '-q', '-am', 'feat');
  headSha = git(origin, 'rev-parse', 'HEAD');
  // GitHub publishes the PR head here; the branch itself may live in a fork.
  git(origin, 'update-ref', 'refs/pull/7/head', headSha);
  git(origin, 'checkout', '-q', 'main');
  git(origin, 'branch', '-q', '-D', 'feat');

  // A clone that has never seen the PR head: only refs/heads/main.
  local = join(tmp, 'work');
  execFileSync('git', ['clone', '-q', asGitUrl(origin), local], { encoding: 'utf8', env });
  repo = await GitRepo.open(local);
});
afterAll(() => rmTmp(tmp));
beforeEach(() => {
  ghCalls = [];
});

describe('viewPr', () => {
  it('passes a number, a #number and a url through to gh, and the branch when nothing is given', async () => {
    for (const [selector, expected] of [
      ['7', '7'],
      ['#7', '7'],
      [' 7 ', '7'],
      ['https://github.com/o/r/pull/7', 'https://github.com/o/r/pull/7'],
      ['feat', 'feat'],
    ] as const) {
      await viewPr(selector, local, gh);
      expect(ghCalls.pop()).toEqual([
        'pr',
        'view',
        expected,
        '--json',
        'number,url,baseRefName,headRefName,headRefOid',
      ]);
    }
    await viewPr(undefined, local, gh);
    expect(ghCalls.pop()).toEqual(['pr', 'view', '--json', 'number,url,baseRefName,headRefName,headRefOid']);
  });

  it('reads the base repository off the pull request url', async () => {
    expect((await viewPr('7', local, gh)).baseRepo).toBe('o/r');
  });

  it('refuses an option-shaped selector before gh sees it', async () => {
    await expect(viewPr('--json', local, gh)).rejects.toThrow(GithubError);
    expect(ghCalls).toEqual([]);
  });

  it('names unusable gh output instead of guessing', async () => {
    const bad: GhRunner = async () => 'not json';
    await expect(viewPr('7', local, bad)).rejects.toThrow(/unexpected output from gh pr view/);
    const noSlug: GhRunner = async () => PR_VIEW({ url: 'https://example.invalid/x' });
    await expect(viewPr('7', local, noSlug)).rejects.toThrow(/cannot read the repository/);
  });
});

describe("resolveMode({ kind: 'pr' })", () => {
  it('fetches the pull request and pins both sides to commits', async () => {
    const mode = await resolveMode({ kind: 'pr', pr: '7' }, repo, gh);
    expect(mode).toMatchObject({
      kind: 'pr',
      old: { kind: 'rev', rev: mergeBase },
      newRev: headSha,
      label: '#7 main...feat',
      repository: 'o/r',
      live: 'none',
      // The number, not a sha: comments outlive a force-push to the pull request.
      commentKey: 'pr:#7',
    });
    expect(git(local, 'rev-parse', `${repo.reviewRefs}/7/head`)).toBe(headSha);
    expect(git(local, 'rev-parse', `${repo.reviewRefs}/7/base`)).toBe(mergeBase);
  });

  it('fetches from the remote that points at the base repository, whatever it is called', async () => {
    const forked = join(tmp, 'forked');
    execFileSync('git', ['clone', '-q', '--origin', 'upstream', asGitUrl(origin), forked], { encoding: 'utf8', env });
    const forkRepo = await GitRepo.open(forked);
    const mode = await resolveMode({ kind: 'pr', pr: '7' }, forkRepo, gh);
    expect(mode.newRev).toBe(headSha);
  });

  it('refuses foreign PRs in an existing session without fetching', async () => {
    const refs = git(local, 'show-ref');
    await expect(
      resolveMode({ kind: 'pr', pr: '7' }, repo, async () =>
        PR_VIEW({ url: 'https://github.com/foreign/repo/pull/7' }),
      ),
    ).rejects.toThrow(/foreign repository/);
    expect(git(local, 'show-ref')).toBe(refs);
  });

  it('cleans only this instance’s refs', async () => {
    const other = await GitRepo.open(local);
    await resolveMode({ kind: 'pr', pr: '7' }, other, gh);
    await repo.cleanReviewRefs();
    expect(git(local, 'for-each-ref', repo.reviewRefs)).toBe('');
    expect(git(local, 'rev-parse', `${other.reviewRefs}/7/head`)).toBe(headSha);
    await other.cleanReviewRefs();
  });

  it('reports a pull request gh cannot find as the user error it is', async () => {
    const missing: GhRunner = async () => {
      throw new GithubError('gh pr view failed: no pull requests found');
    };
    await expect(resolveMode({ kind: 'pr', pr: '999' }, repo, missing)).rejects.toThrow(GithubError);
  });
});

describe('openReviewRepository', () => {
  it('keeps matching PRs in the local repository', async () => {
    const review = await openReviewRepository({ kind: 'pr', pr: '7' }, local, gh);
    expect(review.repo.root).toBe(local);
    await review.close();
    await access(local);
  });

  // POSIX-only: the fake `gh` is a shebang script made runnable with `chmod`, PATH is
  // joined with `:`, and the assertion is on a graceful SIGTERM shutdown.
  it.skipIf(process.platform === 'win32')(
    'removes foreign clones when the CLI receives SIGTERM',
    async () => {
      const bin = join(tmp, 'bin');
      await mkdir(bin);
      const url = 'https://github.com/foreign/cli/pull/7';
      await writeFile(join(bin, 'gh'), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(PR_VIEW({ url }))});\n`);
      await chmod(join(bin, 'gh'), 0o755);
      const config = join(tmp, 'cli-gitconfig');
      await writeFile(config, `[url "${asGitUrl(origin)}"]\n\tinsteadOf = https://github.com/foreign/cli\n`);
      const child = spawn(
        process.execPath,
        [
          join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'),
          join(process.cwd(), 'src/cli/main.ts'),
          '-C',
          local,
          'pr',
          url,
          '--no-open',
          '--no-watch',
          '--port',
          '0',
        ],
        {
          env: { ...env, PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: config, NO_COLOR: '1' },
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
      let stderr = '';
      const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
      try {
        await new Promise<void>((resolve, reject) => {
          child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
            if (stderr.includes('comparing')) resolve();
          });
          child.on('error', reject);
          child.on('exit', () => reject(new Error(stderr)));
        });
        const root = /repo (.+)\n/.exec(stderr)?.[1];
        expect(root).toBeTruthy();
        expect(root).not.toBe(local);
        child.kill('SIGTERM');
        expect(await exited).toBe(0);
        await expect(access(root!)).rejects.toThrow();
      } finally {
        child.kill('SIGKILL');
      }
    },
    15_000,
  );

  it('removes the temporary directory when cloning fails', async () => {
    const scratch = join(tmp, 'failed-clone');
    await mkdir(scratch);
    const config = join(tmp, 'missing-gitconfig');
    await writeFile(config, `[url "${asGitUrl(tmp)}/missing"]\n\tinsteadOf = https://github.com/foreign/missing\n`);
    vi.stubEnv('GIT_CONFIG_GLOBAL', config);
    vi.stubEnv('TMPDIR', scratch);
    try {
      const foreign: GhRunner = async () => PR_VIEW({ url: 'https://github.com/foreign/missing/pull/7' });
      await expect(openReviewRepository({ kind: 'pr', pr: '7' }, local, foreign)).rejects.toThrow();
      expect(await readdir(scratch)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('clones foreign PRs into temp storage, including outside a git repository', async () => {
    const config = join(tmp, 'gitconfig');
    await writeFile(config, `[url "${asGitUrl(origin)}"]\n\tinsteadOf = https://github.com/foreign/repo\n`);
    vi.stubEnv('GIT_CONFIG_GLOBAL', config);
    const foreign: GhRunner = async () => PR_VIEW({ url: 'https://github.com/foreign/repo/pull/7' });
    const refs = git(local, 'show-ref');
    const objects = git(local, 'count-objects', '-v');
    try {
      for (const cwd of [local, tmp]) {
        const req = { kind: 'pr' as const, pr: 'https://github.com/foreign/repo/pull/7' };
        const review = await openReviewRepository(req, cwd, foreign);
        try {
          expect(review.repo.root).not.toBe(local);
          expect(review.repo.root.startsWith(join(TMP_ROOT, 'diffle-pr-'))).toBe(true);
          const mode = await resolveMode(req, review.repo, foreign);
          expect(mode.newRev).toBe(headSha);
          expect(mode.repository).toBe('foreign/repo');
          expect(mode.old).toEqual({ kind: 'rev', rev: mergeBase });
          expect(git(local, 'show-ref')).toBe(refs);
          expect(git(local, 'count-objects', '-v')).toBe(objects);
        } finally {
          await review.close();
        }
        await expect(access(review.repo.root)).rejects.toThrow();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('GitRepo.fetch', () => {
  it('refuses a refspec that would move a ref the user owns', async () => {
    await expect(repo.fetch('origin', ['+refs/heads/main:refs/heads/main'])).rejects.toThrow(/refusing to fetch into/);
    await expect(repo.fetch('origin', ['+refs/heads/main:refs/remotes/origin/main'])).rejects.toThrow(
      /refusing to fetch into/,
    );
  });
});
