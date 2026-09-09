import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GitRepo } from '../../src/server/git/GitRepo.js';
import { GithubError, viewPr, type GhRunner } from '../../src/server/github.js';
import { resolveMode } from '../../src/server/mode.js';

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
  tmp = await mkdtemp(join(tmpdir(), 'diffle-pr-'));
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
  execFileSync('git', ['clone', '-q', origin, local], { encoding: 'utf8', env });
  repo = await GitRepo.open(local);
});
afterAll(() => rm(tmp, { recursive: true, force: true }));
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
      expect(ghCalls.pop()).toEqual(['pr', 'view', expected, '--json', 'number,url,baseRefName,headRefName,headRefOid']);
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
      live: 'none',
      // The number, not a sha: comments outlive a force-push to the pull request.
      commentKey: 'pr:#7',
    });
    expect(git(local, 'rev-parse', 'refs/diffle/pull/7/head')).toBe(headSha);
    expect(git(local, 'rev-parse', 'refs/diffle/pull/7/base')).toBe(mergeBase);
  });

  it('fetches from the remote that points at the base repository, whatever it is called', async () => {
    const forked = join(tmp, 'forked');
    execFileSync('git', ['clone', '-q', '--origin', 'upstream', origin, forked], { encoding: 'utf8', env });
    const forkRepo = await GitRepo.open(forked);
    const mode = await resolveMode({ kind: 'pr', pr: '7' }, forkRepo, gh);
    expect(mode.newRev).toBe(headSha);
  });

  it('reports a pull request gh cannot find as the user error it is', async () => {
    const missing: GhRunner = async () => {
      throw new GithubError('gh pr view failed: no pull requests found');
    };
    await expect(resolveMode({ kind: 'pr', pr: '999' }, repo, missing)).rejects.toThrow(GithubError);
  });
});

describe('GitRepo.fetch', () => {
  it('refuses a refspec that would move a ref the user owns', async () => {
    await expect(repo.fetch('origin', ['+refs/heads/main:refs/heads/main'])).rejects.toThrow(/refusing to fetch into/);
    await expect(repo.fetch('origin', ['+refs/heads/main:refs/remotes/origin/main'])).rejects.toThrow(/refusing to fetch into/);
  });
});
