import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmTmp } from '../tmp.js';
import { GitRepo } from '@/server/git/GitRepo.js';
import { apiBaseUrl, chooseInstance, GITHUB_COM, githubRepository } from '@/server/github/hosts.js';

const ENTERPRISE = { host: 'github.work.com', gitHosts: ['github.work.com', 'ssh.work.com'] };

describe('githubRepository', () => {
  it.each([
    'https://github.com/o/r',
    'https://github.com/o/r.git',
    'https://user@github.com/o/r/',
    'ssh://git@github.com:22/o/r.git',
    'git@github.com:o/r.git',
    'github.com:o/r',
  ])('reads o/r from %s', (url) => {
    expect(githubRepository(url, GITHUB_COM)).toBe('o/r');
  });

  it('reads remotes on the instance’s hosts alone, whatever their case', () => {
    expect(githubRepository('git@SSH.work.com:team/svc.git', ENTERPRISE)).toBe('team/svc');
    expect(githubRepository('https://github.work.com/team/svc', ENTERPRISE)).toBe('team/svc');
    expect(githubRepository('https://github.com/o/r', ENTERPRISE)).toBeNull();
    expect(githubRepository('https://github.work.com/team/svc', GITHUB_COM)).toBeNull();
    expect(githubRepository('https://github.com.evil.example/o/r', GITHUB_COM)).toBeNull();
    expect(githubRepository('https://github.com/o/r/tree/main', GITHUB_COM)).toBeNull();
  });
});

describe('apiBaseUrl', () => {
  it('knows where github.com, GHE.com and a GitHub Enterprise Server keep their API', () => {
    expect(apiBaseUrl(GITHUB_COM)).toBe('https://api.github.com');
    expect(apiBaseUrl({ host: 'acme.ghe.com', gitHosts: [] })).toBe('https://api.acme.ghe.com');
    expect(apiBaseUrl(ENTERPRISE)).toBe('https://github.work.com/api/v3');
  });
});

describe('chooseInstance', () => {
  let tmp: string;
  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'diffle-hosts-'));
  });
  afterAll(() => rmTmp(tmp));

  /** A repository with these remotes, `origin` first when named. */
  async function repoWith(name: string, remotes: Record<string, string>): Promise<GitRepo> {
    const dir = join(tmp, name);
    execFileSync('git', ['init', '-q', dir]);
    for (const [remote, url] of Object.entries(remotes)) execFileSync('git', ['-C', dir, 'remote', 'add', remote, url]);
    return GitRepo.open(dir);
  }

  const hosts = { 'ssh.work.com': 'github.work.com' };

  it('follows a configured origin, through its git host to its web host', async () => {
    const repo = await repoWith('origin', { origin: 'git@ssh.work.com:team/svc.git', gh: 'https://github.com/o/r' });
    expect(await chooseInstance(hosts, repo)).toEqual(ENTERPRISE);
    expect(await chooseInstance({}, repo)).toEqual(GITHUB_COM);
  });

  it('takes the one host every GitHub remote shares when origin is not one', async () => {
    const one = await repoWith('one', { origin: 'https://gitlab.com/o/r', up: 'https://github.work.com/team/svc' });
    expect(await chooseInstance(hosts, one)).toEqual(ENTERPRISE);
    const two = await repoWith('two', { up: 'https://github.work.com/team/svc', gh: 'https://github.com/o/r' });
    expect(await chooseInstance(hosts, two)).toEqual(GITHUB_COM);
  });

  it('follows a pull request url anywhere, configured or not', async () => {
    const repo = await repoWith('pr', { origin: 'https://github.com/o/r' });
    expect(await chooseInstance(hosts, repo, 'https://github.work.com/team/svc/pull/7')).toEqual(ENTERPRISE);
    expect(await chooseInstance({}, null, 'https://ghes.example/team/svc/pull/7')).toEqual({
      host: 'ghes.example',
      gitHosts: ['ghes.example'],
    });
    expect(await chooseInstance(hosts, repo, '7')).toEqual(GITHUB_COM);
  });
});
