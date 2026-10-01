import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChannel, isNewer, latestRelease, RELEASES_URL, updateCommand } from '../../src/cli/update.js';
import pkg from '../../package.json' with { type: 'json' };
import { startDiffle } from '../e2e/server.js';
import { rmTmp } from '../tmp.js';

const DAY = 24 * 60 * 60 * 1000;
const RELEASE = { tag_name: 'v0.2.0', html_url: 'https://github.com/moritzwilksch/diffle/releases/tag/v0.2.0' };

let dir: string;
let cacheFile: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'diffle-update-'));
  cacheFile = join(dir, 'cache', 'latest-release.json');
});
afterEach(() => rmTmp(dir));

function answering(body: unknown, status = 200) {
  return vi.fn(async () => Response.json(body, { status }));
}

describe('latestRelease', () => {
  it('asks GitHub once a day and answers from the cache in between', async () => {
    const request = answering(RELEASE);
    const at = (now: number) => latestRelease({ cacheFile, request, now: () => now });
    const release = { version: '0.2.0', url: RELEASE.html_url };
    expect(await at(1000)).toEqual(release);
    expect(await at(1000 + DAY - 1)).toEqual(release);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(RELEASES_URL, expect.anything());
    request.mockResolvedValueOnce(Response.json({ ...RELEASE, tag_name: 'v0.3.0' }));
    expect(await at(1000 + DAY)).toEqual({ ...release, version: '0.3.0' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('keeps the last good answer when GitHub fails, and null without one', async () => {
    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await latestRelease({ cacheFile, request: offline })).toBeNull();
    await latestRelease({ cacheFile, request: answering(RELEASE), now: () => 0 });
    const stale = { cacheFile, now: () => 2 * DAY };
    expect(await latestRelease({ ...stale, request: offline })).toMatchObject({ version: '0.2.0' });
    expect(await latestRelease({ ...stale, request: answering({ message: 'rate limited' }, 403) })).toMatchObject({
      version: '0.2.0',
    });
    expect(await latestRelease({ ...stale, request: answering({ tag_name: 1 }) })).toMatchObject({ version: '0.2.0' });
  });

  it('ignores a cache another endpoint filled, and answers without a writable cache', async () => {
    await latestRelease({ cacheFile, request: answering(RELEASE), source: 'http://127.0.0.1:1/stub' });
    expect(JSON.parse(await readFile(cacheFile, 'utf8'))).toMatchObject({ source: 'http://127.0.0.1:1/stub' });
    const request = answering({ ...RELEASE, tag_name: 'v0.3.0' });
    expect(await latestRelease({ cacheFile, request })).toMatchObject({ version: '0.3.0' });
    await writeFile(join(dir, 'file'), '');
    const unwritable = join(dir, 'file', 'latest-release.json');
    expect(await latestRelease({ cacheFile: unwritable, request })).toMatchObject({ version: '0.3.0' });
  });
});

describe('isNewer', () => {
  it.each([
    ['0.1.9', '0.1.8', true],
    ['0.2.0', '0.1.10', true],
    ['1.0.0', '0.99.99', true],
    ['v0.1.9', '0.1.8', true],
    ['0.1.8', '0.1.8', false],
    ['0.1.8', '0.1.9', false],
    ['0.1.10', '0.1.9', true],
    ['0.2.0', '0.2.0-rc.1', true],
    ['0.2.0-rc.1', '0.2.0', false],
    ['nightly', '0.1.8', false],
  ])('%s over %s: %s', (a, b, expected) => {
    expect(isNewer(a, b)).toBe(expected);
  });
});

describe('installChannel and updateCommand', () => {
  const home = '/home/u';
  const prefixes = new Set(['/home/u/.pixi/envs/diffle', '/work/app/.pixi/envs/default', '/opt/conda']);
  const channel = (script: string) =>
    installChannel(script, { home, isCondaPrefix: (d) => prefixes.has(d.replaceAll('\\', '/')) });
  const main = 'node_modules/@moritzwilksch/diffle/dist/server/main.js';

  it('names each install and the command that updates it', async () => {
    const scripts = [
      `/usr/local/lib/${main}`,
      `/home/u/.npm/_npx/0a1b/${main}`,
      `/home/u/.pixi/envs/diffle/lib/${main}`,
      `/work/app/.pixi/envs/default/lib/${main}`,
      `/opt/conda/lib/${main}`,
      `/nix/store/abc-diffle-0.1.8/lib/${main}`,
      '/home/u/src/diffle/src/cli/main.ts',
    ];
    const binary = (platform: NodeJS.Platform, execPath: string) =>
      updateCommand('binary', { platform, execPath, home, localAppData: 'C:\\Users\\u\\AppData\\Local' });
    const lines = [
      ...scripts.map((script) => {
        const c = channel(script);
        return `${script}\n  ${c}: ${updateCommand(c) ?? '(none)'}`;
      }),
      ...[`${home}/.local/bin/diffle`, '/opt/my tools/diffle'].map((p) => `binary at ${p}\n  ${binary('linux', p)}`),
      ...['C:\\Users\\u\\AppData\\Local\\Programs\\diffle\\diffle.exe', "D:\\it's\\diffle.exe"].map(
        (p) => `binary at ${p}\n  ${binary('win32', p)}`,
      ),
    ];
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('__snapshots__/update-channels.txt');
  });
});

describe('the startup notice', () => {
  it('names a newer release and the command for this install once diffle is up', async () => {
    const repo = join(dir, 'repo');
    await mkdir(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    // GitHub's `releases/latest` stands in locally: no network, and no dependence on the last real release.
    const stub = createServer((_req, res) =>
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ...RELEASE, tag_name: 'v99.0.0' })),
    );
    await new Promise<void>((done) => stub.listen(0, '127.0.0.1', done));
    const diffle = await startDiffle({
      repo,
      env: {
        DIFFLE_NO_UPDATE_CHECK: '',
        DIFFLE_UPDATE_URL: `http://127.0.0.1:${(stub.address() as AddressInfo).port}/releases/latest`,
        XDG_CACHE_HOME: join(dir, 'cache'),
      },
    });
    try {
      const line = await new Promise<string>((done) => {
        let stderr = '';
        diffle.proc.stderr!.on('data', (chunk: Buffer) => {
          stderr += chunk;
          const match = /^.*is available.*$/m.exec(stderr);
          if (match) done(match[0]);
        });
      });
      // A checkout has no update command of its own, so the notice links the release.
      expect(line).toBe(`✨ diffle 99.0.0 is available (this is ${pkg.version}): ${RELEASE.html_url}`);
    } finally {
      await diffle.stop();
      await new Promise((done) => stub.close(done));
    }
  }, 60_000);
});
