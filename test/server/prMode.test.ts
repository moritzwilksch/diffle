import { execFileSync, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmTmp } from '../tmp.js';
import { openReviewRepository } from '../../src/cli/repository.js';
import { GitRepo } from '../../src/server/git/GitRepo.js';
import { GithubError, listPrsForHead, viewPr, type GhRunner } from '../../src/server/github.js';
import { discoverGithub, githubRepository, originRepository } from '../../src/server/GithubMetadata.js';
import { Session } from '../../src/server/Session.js';
import { Snapshotter } from '../../src/server/Snapshotter.js';
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

/** What `gh pr view` would say for PR 7 of o/r. */
const PR_VIEW = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    title: 'Improve feature',
    state: 'OPEN',
    isDraft: false,
    baseRefOid: mergeBase,
    number: 7,
    url: 'https://github.com/o/r/pull/7',
    baseRefName: 'main',
    headRefName: 'feat',
    headRefOid: 'unused-here',
    headRepository: { name: 'r' },
    headRepositoryOwner: { login: 'o' },
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
        'number,url,title,state,isDraft,baseRefOid,baseRefName,headRefName,headRefOid',
      ]);
    }
    await viewPr(undefined, local, gh);
    expect(ghCalls.pop()).toEqual([
      'pr',
      'view',
      '--json',
      'number,url,title,state,isDraft,baseRefOid,baseRefName,headRefName,headRefOid',
    ]);
  });

  it('reads the base repository off the pull request url', async () => {
    expect((await viewPr('7', local, gh)).baseRepo).toBe('o/r');
  });

  it('lists open pull requests for an explicit remote branch', async () => {
    const prs = await listPrsForHead('o/r', 'main', 'feat', 'o/r', local, async (args) => {
      ghCalls.push(args);
      return JSON.stringify([
        JSON.parse(PR_VIEW()),
        JSON.parse(PR_VIEW({ number: 8, headRepositoryOwner: { login: 'other' } })),
      ]);
    });
    expect(prs.map((pr) => pr.number)).toEqual([7]);
    expect(ghCalls[0]).toEqual([
      'pr',
      'list',
      '--repo',
      'o/r',
      '--base',
      'main',
      '--head',
      'feat',
      '--state',
      'open',
      '--limit',
      '100',
      '--json',
      'number,url,title,state,isDraft,baseRefOid,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner',
    ]);
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

describe("resolveReview({ kind: 'pr' })", () => {
  it('fetches the pull request and pins both sides to commits', async () => {
    const { mode, prUrl } = await resolveReview({ kind: 'pr', pr: '7' }, repo, gh);
    expect(mode).toMatchObject({
      old: mergeBase,
      mergeBase: false,
      new: headSha,
      label: '#7 main...feat',
      live: 'none',
      // The number, not a sha: comments outlive a force-push to the pull request.
      commentKey: 'pr:#7',
    });
    expect(mode).not.toHaveProperty('request');
    expect(prUrl).toBe('https://github.com/o/r/pull/7');
    expect(git(local, 'rev-parse', `${repo.reviewRefs}/7/head`)).toBe(headSha);
    expect(git(local, 'rev-parse', `${repo.reviewRefs}/7/base`)).toBe(mergeBase);
  });

  it('fetches from the remote that points at the base repository, whatever it is called', async () => {
    const forked = join(tmp, 'forked');
    execFileSync('git', ['clone', '-q', '--origin', 'upstream', asGitUrl(origin), forked], { encoding: 'utf8', env });
    const forkRepo = await GitRepo.open(forked);
    const { mode } = await resolveReview({ kind: 'pr', pr: '7' }, forkRepo, gh);
    expect(mode.new).toBe(headSha);
  });

  it('refuses foreign PRs in an existing session without fetching', async () => {
    const refs = git(local, 'show-ref');
    await expect(
      resolveReview({ kind: 'pr', pr: '7' }, repo, async () =>
        PR_VIEW({ url: 'https://github.com/foreign/repo/pull/7' }),
      ),
    ).rejects.toThrow(/foreign repository/);
    expect(git(local, 'show-ref')).toBe(refs);
  });

  it('cleans only this instance’s refs', async () => {
    const other = await GitRepo.open(local);
    await resolveReview({ kind: 'pr', pr: '7' }, other, gh);
    await repo.cleanReviewRefs();
    expect(git(local, 'for-each-ref', repo.reviewRefs)).toBe('');
    expect(git(local, 'rev-parse', `${other.reviewRefs}/7/head`)).toBe(headSha);
    await other.cleanReviewRefs();
  });

  it('reports a pull request gh cannot find as the user error it is', async () => {
    const missing: GhRunner = async () => {
      throw new GithubError('gh pr view failed: no pull requests found');
    };
    await expect(resolveReview({ kind: 'pr', pr: '999' }, repo, missing)).rejects.toThrow(GithubError);
  });
});

describe('independent GitHub metadata', () => {
  async function checkedOut<T>(fn: () => Promise<T>): Promise<T> {
    git(local, 'update-ref', 'refs/remotes/origin/feat', headSha);
    git(local, 'checkout', '-q', '-B', 'feat', '--track', 'origin/feat');
    const remotes = vi.spyOn(repo, 'remotes').mockResolvedValue([{ name: 'origin', url: 'git@github.com:o/r.git' }]);
    try {
      return await fn();
    } finally {
      remotes.mockRestore();
      git(local, 'checkout', '-q', 'main');
      git(local, 'branch', '-q', '-D', 'feat');
      git(local, 'update-ref', '-d', 'refs/remotes/origin/feat');
    }
  }
  const snapshot = async (args: string[]) =>
    new Snapshotter(repo, (await resolveReview({ kind: 'revspec', args }, repo)).mode, 1, 3).current();
  const found: GhRunner = async (args, opts) => {
    ghCalls.push(args);
    expect(opts.timeoutMs).toBe(5000);
    return JSON.stringify([JSON.parse(PR_VIEW({ headRefOid: headSha }))]);
  };

  it('discovers both upstreams without promoting, pinning, or fetching the comparison', async () =>
    checkedOut(async () => {
      const fetch = vi.spyOn(repo, 'fetch');
      try {
        const snap = await snapshot(['origin/main']);
        const before = structuredClone(snap.mode);
        const metadata = await discoverGithub(repo, snap, { run: found });
        expect(metadata).toMatchObject({
          canExport: true,
          pullRequest: { repository: 'o/r', number: 7, title: 'Improve feature', state: 'OPEN', isDraft: false },
        });
        expect(snap.mode).toEqual(before);
        expect(snap.mode).toMatchObject({ old: 'origin/main', new: 'HEAD', mergeBase: true, live: 'refs' });
        expect(snap.mode).not.toHaveProperty('kind');
        expect(fetch).not.toHaveBeenCalled();
        expect(ghCalls[0]?.slice(0, 8)).toEqual(['pr', 'list', '--repo', 'o/r', '--base', 'main', '--head', 'feat']);
      } finally {
        fetch.mockRestore();
      }
    }));

  it('resolves exact local and remote branches, but never expressions or tags', async () =>
    checkedOut(async () => {
      expect(await repo.upstreamBranch('HEAD')).toEqual({ remote: 'origin', branch: 'feat' });
      expect(await repo.upstreamBranch('feat')).toEqual({ remote: 'origin', branch: 'feat' });
      expect(await repo.upstreamBranch('origin/main')).toEqual({ remote: 'origin', branch: 'main' });
      expect(await repo.upstreamBranch('HEAD~1')).toBeNull();
      expect(await repo.upstreamBranch(headSha)).toBeNull();
      expect(await repo.upstreamBranch('worktree')).toBeNull();
      git(local, 'tag', 'metadata-tag', headSha);
      try {
        expect(await repo.upstreamBranch('metadata-tag')).toBeNull();
      } finally {
        git(local, 'tag', '-d', 'metadata-tag');
      }
      git(local, 'checkout', '-q', '--detach', headSha);
      expect(await repo.upstreamBranch('HEAD')).toBeNull();
    }));

  it('skips GitHub for a worktree or an expression on either endpoint', async () =>
    checkedOut(async () => {
      for (const args of [['origin/main..worktree'], ['worktree..HEAD'], ['HEAD~1..HEAD']]) {
        const metadata = await discoverGithub(repo, await snapshot(args), { run: found });
        expect(metadata.pullRequest).toBeNull();
      }
      expect(ghCalls).toEqual([]);
    }));

  it('shows metadata for an unpushed branch but refuses export', async () =>
    checkedOut(async () => {
      const metadata = await discoverGithub(repo, await snapshot(['origin/main']), {
        run: async () => JSON.stringify([JSON.parse(PR_VIEW({ headRefOid: mergeBase }))]),
      });
      expect(metadata.pullRequest?.number).toBe(7);
      expect(metadata.canExport).toBe(false);
      expect(metadata.reason).toMatch(/head/);
    }));

  it('shows matching metadata even when the old commit differs from GitHub’s diff', async () =>
    checkedOut(async () => {
      const snap = await snapshot(['origin/main']);
      const metadata = await discoverGithub(repo, { ...snap, oldSha: headSha }, { run: found });
      expect(metadata.pullRequest?.number).toBe(7);
      expect(metadata.canExport).toBe(false);
      expect(metadata.reason).toMatch(/does not match/);
    }));

  it('does not select an arbitrary PR when discovery is ambiguous', async () =>
    checkedOut(async () => {
      const metadata = await discoverGithub(repo, await snapshot(['origin/main']), {
        run: async () =>
          JSON.stringify([
            JSON.parse(PR_VIEW({ headRefOid: headSha })),
            JSON.parse(PR_VIEW({ number: 8, headRefOid: headSha })),
          ]),
      });
      expect(metadata.pullRequest).toBeNull();
      expect(metadata.reason).toMatch(/Multiple/);
    }));

  it('keeps an explicit PR identity when neither commit has a branch', async () => {
    const { mode, prUrl } = await resolveReview({ kind: 'pr', pr: '7' }, repo, gh);
    const snap = await new Snapshotter(repo, mode, 1, 3).current();
    const metadata = await discoverGithub(repo, snap, {
      prUrl,
      run: async (args) => {
        expect(args[2]).toBe('https://github.com/o/r/pull/7');
        return PR_VIEW({ headRefOid: headSha, isDraft: true });
      },
    });
    expect(metadata).toMatchObject({ canExport: true, pullRequest: { number: 7, isDraft: true } });
  });

  it('keeps explicit PR identity in the session across refreshes and clears it on a comparison switch', async () => {
    const run = vi.fn<GhRunner>(async () => PR_VIEW({ headRefOid: headSha }));
    const session = new Session(repo, { broadcast() {} }, { watch: false, context: 3, gh: run });
    try {
      const first = await session.start({ kind: 'pr', pr: '7' });
      expect(first.mode).not.toHaveProperty('request');
      expect(first.mode).not.toHaveProperty('prUrl');
      expect((await session.github(first)).pullRequest?.number).toBe(7);
      expect(run.mock.calls.at(-1)?.[0][2]).toBe('https://github.com/o/r/pull/7');
      await session.refresh();
      const refreshed = await session.snapshotter.current();
      expect((await session.github(refreshed)).pullRequest?.number).toBe(7);
      await session.setContext(9);
      expect((await session.github(await session.snapshotter.current())).pullRequest?.number).toBe(7);
      const next = await session.switchMode({ kind: 'working' });
      run.mockClear();
      expect((await session.github(next)).pullRequest).toBeNull();
      expect(run).not.toHaveBeenCalled();
      await expect(session.github(first)).rejects.toThrow('Comparison changed');
    } finally {
      await session.close();
    }
  });

  it('reads origin locally and recognizes GitHub URL forms', async () =>
    checkedOut(async () => {
      expect(await originRepository(repo)).toBe('o/r');
      for (const url of ['https://github.com/o/r.git', 'git@github.com:o/r.git', 'ssh://git@github.com/o/r.git'])
        expect(githubRepository(url)).toBe('o/r');
      expect(githubRepository('https://notgithub.com/o/r')).toBeNull();
      expect(githubRepository('/local/o/r')).toBeNull();
    }));
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
          // The clone is made under the raw `os.tmpdir()`, so canonicalize both sides: a
          // Windows 8.3 short name or a macOS symlink would otherwise skew the prefix.
          const root = await realpath(review.repo.root);
          expect(root.startsWith(join(await realpath(tmpdir()), 'diffle-pr-'))).toBe(true);
          const { mode, prUrl } = await resolveReview(req, review.repo, foreign);
          expect(mode.new).toBe(headSha);
          expect(prUrl).toBe('https://github.com/foreign/repo/pull/7');
          expect(mode.old).toBe(mergeBase);
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
