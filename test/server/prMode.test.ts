import { execFileSync, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { access, mkdir, mkdtemp, readdir, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmTmp } from '../tmp.js';
import { openReviewRepository } from '../../src/cli/repository.js';
import { GitRepo } from '../../src/server/git/GitRepo.js';
import { type GithubClient, GithubError } from '../../src/server/github/client.js';
import { viewPr } from '../../src/server/github/pulls.js';
import { resolveReview } from '../../src/server/mode.js';

/**
 * The temp root as git reports it: macOS reaches `os.tmpdir()` through a symlink
 * (`/var` → `/private/var`), and Windows hands out an 8.3 short name (`RUNNER~1`)
 * that only libuv's realpath expands — the JS `realpathSync` keeps it.
 */
const TMP_ROOT = realpathSync.native(tmpdir());

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

/**
 * Makes `origin` look like github.com/o/r while fetching from the local bare repository: the
 * lookup reads the GitHub identity off the remote url, and the fetch rewrites it back.
 */
function pointRemoteAtGithub(cwd: string, remote = 'origin'): void {
  git(cwd, 'remote', 'set-url', remote, 'https://github.com/o/r');
  git(cwd, 'config', `url.${asGitUrl(origin)}.insteadOf`, 'https://github.com/o/r');
}

/** What GitHub would say for PR 7 of o/r. */
const PR_NODE = (over: Record<string, unknown> = {}) => ({
  title: 'Improve feature',
  state: 'OPEN',
  isDraft: false,
  baseRefOid: mergeBase,
  number: 7,
  url: 'https://github.com/o/r/pull/7',
  baseRefName: 'main',
  headRefName: 'feat',
  headRefOid: 'unused-here',
  headRepository: { name: 'r', owner: { login: 'o' } },
  ...over,
});

/** A GitHub that knows one pull request, answering lookups by number and by head branch alike. */
function fake(node: Record<string, unknown> | null = PR_NODE(), over: Record<string, unknown> = {}): GithubClient {
  const pr = node && { ...node, ...over };
  return {
    async graphql<T>(query: string, variables: Record<string, unknown>) {
      calls.push(variables);
      if (query.includes('pullRequests(')) return { repository: { pullRequests: { nodes: pr ? [pr] : [] } } } as T;
      return { repository: { pullRequest: pr } } as T;
    },
  };
}

let calls: Record<string, unknown>[] = [];
/** Knows PR 7; made once the fixture's hashes exist. */
let github: GithubClient;

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
  pointRemoteAtGithub(local);
  repo = await GitRepo.open(local);
  github = fake();
});
afterAll(() => rmTmp(tmp));
beforeEach(() => {
  calls = [];
});

describe('viewPr', () => {
  it('looks a number, a #number and a url up by number in the base repository', async () => {
    for (const selector of ['7', '#7', ' 7 ', 'https://github.com/o/r/pull/7', 'https://github.com/o/r/pull/7/files']) {
      await viewPr(selector, repo, github);
      expect(calls.pop()).toEqual({ owner: 'o', repo: 'r', number: 7 });
    }
    // A url names its own repository: no local checkout needed.
    await viewPr('https://github.com/other/place/pull/9', null, fake(PR_NODE({ number: 9 })));
    expect(calls.pop()).toEqual({ owner: 'other', repo: 'place', number: 9 });
  });

  it('looks a branch up among the open pull requests with that head, in any fork or the named one', async () => {
    await viewPr('feat', repo, github);
    expect(calls.pop()).toEqual({ owner: 'o', repo: 'r', head: 'feat', base: null });
    expect((await viewPr('o:feat', repo, github)).number).toBe(7);
    await expect(viewPr('someone:feat', repo, github)).rejects.toThrow(/no open pull request in o\/r for someone:feat/);
    await expect(viewPr('feat', repo, fake(null))).rejects.toThrow(/no open pull request in o\/r for feat/);
    const two: GithubClient = {
      async graphql<T>() {
        return { repository: { pullRequests: { nodes: [PR_NODE(), PR_NODE({ number: 8 })] } } } as T;
      },
    };
    await expect(viewPr('feat', repo, two)).rejects.toThrow(/2 open pull requests .*open one by number/);
  });

  it("uses the checked-out branch's upstream when nothing is given", async () => {
    const work = join(tmp, 'branch');
    execFileSync('git', ['clone', '-q', asGitUrl(origin), work], { encoding: 'utf8', env });
    pointRemoteAtGithub(work);
    git(work, 'checkout', '-q', '-b', 'feat');
    git(work, 'branch', '-q', '--set-upstream-to=origin/main');
    const branchRepo = await GitRepo.open(work);
    // The upstream names the branch on GitHub; the local name may differ.
    expect((await viewPr(undefined, branchRepo, github)).number).toBe(7);
    expect(calls.pop()).toEqual({ owner: 'o', repo: 'r', head: 'main', base: null });
    git(work, 'branch', '-q', '--unset-upstream');
    // Without an upstream, the local branch name is the best guess.
    await viewPr(undefined, branchRepo, github);
    expect(calls.pop()).toEqual({ owner: 'o', repo: 'r', head: 'feat', base: null });
    git(work, 'checkout', '-q', '--detach');
    await expect(viewPr(undefined, branchRepo, github)).rejects.toThrow(/not on a branch/);
  });

  it('reads the base repository off the pull request url', async () => {
    expect((await viewPr('7', repo, github)).repository).toBe('o/r');
  });

  it('refuses an option-shaped selector and a non-pull-request url before asking GitHub', async () => {
    await expect(viewPr('--json', repo, github)).rejects.toThrow(GithubError);
    await expect(viewPr('https://github.com/o/r/issues/7', repo, github)).rejects.toThrow(/not a pull request url/);
    expect(calls).toEqual([]);
  });

  it('needs a GitHub origin, or one GitHub remote, for everything but a url', async () => {
    await expect(viewPr('7', null, github)).rejects.toThrow(/not in a git repository/);
    const dir = join(tmp, 'no-origin');
    git(tmp, 'init', '-q', dir);
    await expect(viewPr('7', await GitRepo.open(dir), github)).rejects.toThrow(/no GitHub remote/);
    git(dir, 'remote', 'add', 'fork', 'git@github.com:me/r.git');
    expect((await viewPr('7', await GitRepo.open(dir), github)).number).toBe(7);
    expect(calls.pop()).toEqual({ owner: 'me', repo: 'r', number: 7 });
    git(dir, 'remote', 'add', 'other', 'https://github.com/o/r');
    await expect(viewPr('7', await GitRepo.open(dir), github)).rejects.toThrow(/2 GitHub remotes and no origin/);
    expect(calls).toEqual([]);
  });

  it('normalizes the head repository and accepts a deleted fork', async () => {
    expect((await viewPr('7', repo, github)).headRepository).toBe('o/r');
    expect((await viewPr('7', repo, fake(PR_NODE({ headRepository: null })))).headRepository).toBeNull();
  });

  it.each([
    { headRepository: { name: 'r', owner: { login: 3 } } },
    { headRepository: { name: 'r' } },
    { headRepository: undefined },
    { state: 'UNKNOWN' },
    { headRefOid: null },
  ])('rejects malformed PR fields: %j', async (fields) => {
    await expect(viewPr('7', repo, fake(PR_NODE(fields)))).rejects.toMatchObject({
      message: 'unexpected pull request data from GitHub',
      status: 502,
    });
  });

  it('names unusable GitHub data instead of guessing', async () => {
    await expect(viewPr('7', repo, fake(null))).rejects.toThrow(/no pull request o\/r#7/);
    await expect(viewPr('7', repo, fake(PR_NODE({ title: 3 })))).rejects.toThrow(/unexpected pull request data/);
    await expect(viewPr('7', repo, fake(PR_NODE({ url: 'https://example.invalid/x' })))).rejects.toThrow(
      /cannot read the repository/,
    );
  });
});

describe("resolveReview({ kind: 'pr' })", () => {
  it('fetches the pull request into fixed refs retaining both branch names', async () => {
    const { mode, prUrl } = await resolveReview({ kind: 'pr', pr: '7' }, repo, github);
    expect(mode).toMatchObject({
      old: `${repo.reviewRefs}/7/base/main`,
      mergeBase: true,
      new: `${repo.reviewRefs}/7/head/feat`,

      live: 'none',
      // Branch identities share review state with ordinary branch comparisons.
      commentKey: 'branches:["o/r:main","o/r:feat",true]',
    });
    expect(mode).not.toHaveProperty('request');
    expect(prUrl).toBe('https://github.com/o/r/pull/7');
    expect(git(local, 'rev-parse', `${repo.reviewRefs}/7/head/feat`)).toBe(headSha);
    expect(git(local, 'rev-parse', `${repo.reviewRefs}/7/base/main`)).toBe(mergeBase);
  });

  it('fetches from the remote that points at the base repository, whatever it is called', async () => {
    const forked = join(tmp, 'forked');
    execFileSync('git', ['clone', '-q', '--origin', 'upstream', asGitUrl(origin), forked], { encoding: 'utf8', env });
    pointRemoteAtGithub(forked, 'upstream');
    const forkRepo = await GitRepo.open(forked);
    const { mode } = await resolveReview({ kind: 'pr', pr: '7' }, forkRepo, github);
    expect(await forkRepo.resolve(mode.new)).toBe(headSha);
  });

  it('refuses foreign PRs in an existing session without fetching', async () => {
    const refs = git(local, 'show-ref');
    await expect(
      resolveReview({ kind: 'pr', pr: '7' }, repo, fake(PR_NODE({ url: 'https://github.com/foreign/repo/pull/7' }))),
    ).rejects.toThrow(/foreign repository/);
    expect(git(local, 'show-ref')).toBe(refs);
  });

  it('cleans only this instance’s refs', async () => {
    const other = await GitRepo.open(local);
    await resolveReview({ kind: 'pr', pr: '7' }, other, github);
    await repo.cleanReviewRefs();
    expect(git(local, 'for-each-ref', repo.reviewRefs)).toBe('');
    expect(git(local, 'rev-parse', `${other.reviewRefs}/7/head/feat`)).toBe(headSha);
    await other.cleanReviewRefs();
  });

  it('reports a pull request GitHub cannot find as the user error it is', async () => {
    await expect(resolveReview({ kind: 'pr', pr: '999' }, repo, fake(null))).rejects.toThrow(GithubError);
  });

  it('is off without a token', async () => {
    await expect(resolveReview({ kind: 'pr', pr: '7' }, repo)).rejects.toThrow(/No GitHub token/);
    await expect(openReviewRepository({ kind: 'pr', pr: '7' }, local, null)).rejects.toThrow(/No GitHub token/);
  });
});

describe('openReviewRepository', () => {
  it('keeps matching PRs in the local repository', async () => {
    const review = await openReviewRepository({ kind: 'pr', pr: '7' }, local, github);
    expect(review.repo.root).toBe(local);
    await review.close();
    await access(local);
  });

  // POSIX-only: the assertion is on a graceful SIGTERM shutdown, which Windows cannot deliver.
  it.skipIf(process.platform === 'win32')(
    'removes foreign clones when the CLI receives SIGTERM',
    async () => {
      const url = 'https://github.com/foreign/cli/pull/7';
      // A GitHub API on localhost: the CLI reaches it through GITHUB_API_URL, as in Actions.
      const api = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          const auth = req.headers.authorization;
          const ok = req.url === '/graphql' && auth?.endsWith(' test-token') && body.includes('pullRequest(');
          res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
          res.end(JSON.stringify(ok ? { data: { repository: { pullRequest: PR_NODE({ url }) } } } : { message: 'no' }));
        });
      });
      await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
      const config = join(tmp, 'cli-gitconfig');
      await writeFile(config, `[url "${asGitUrl(origin)}"]\n\tinsteadOf = https://github.com/foreign/cli\n`);
      // Load TypeScript in-process so SIGTERM reaches diffle, not tsx's signal relay.
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
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
          env: {
            ...env,
            GIT_CONFIG_GLOBAL: config,
            NO_COLOR: '1',
            GITHUB_TOKEN: 'test-token',
            GITHUB_API_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
          },
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
        expect(stderr).toContain('token from GITHUB_TOKEN');
        const root = /repo (.+)\n/.exec(stderr)?.[1];
        expect(root).toBeTruthy();
        expect(root).not.toBe(local);
        child.kill('SIGTERM');
        expect(await exited).toBe(0);
        await expect(access(root!)).rejects.toThrow();
      } finally {
        child.kill('SIGKILL');
        api.close();
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
      const foreign = fake(PR_NODE({ url: 'https://github.com/foreign/missing/pull/7' }));
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
    const foreign = fake(PR_NODE({ url: 'https://github.com/foreign/repo/pull/7' }));
    const refs = git(local, 'show-ref');
    const objects = git(local, 'count-objects', '-v');
    try {
      for (const cwd of [local, tmp]) {
        const req = { kind: 'pr' as const, pr: 'https://github.com/foreign/repo/pull/7' };
        const review = await openReviewRepository(req, cwd, foreign);
        try {
          expect(review.repo.root).not.toBe(local);
          // The clone is made under the raw `os.tmpdir()`, so canonicalize both sides: a
          // Windows 8.3 short name or a macOS symlink would otherwise skew the prefix.
          const root = await realpath(review.repo.root);
          expect(root.startsWith(join(await realpath(tmpdir()), 'diffle-pr-'))).toBe(true);
          const { mode, prUrl } = await resolveReview(req, review.repo, foreign);
          expect(await review.repo.resolve(mode.new)).toBe(headSha);
          expect(prUrl).toBe('https://github.com/foreign/repo/pull/7');
          expect(await review.repo.resolve(mode.old)).toBe(mergeBase);
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
