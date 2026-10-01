import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checksumFor, installRelease, releaseAsset, replaceExecutable } from '../../src/cli/selfUpdate.js';
import { rmTmp } from '../tmp.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'diffle-self-update-'));
});
afterEach(() => rmTmp(dir));

describe('releaseAsset', () => {
  it.each([
    ['linux', 'x64', 'diffle-linux-x64.tar.gz'],
    ['linux', 'arm64', 'diffle-linux-arm64.tar.gz'],
    ['darwin', 'arm64', 'diffle-darwin-arm64.tar.gz'],
    ['darwin', 'x64', null],
    ['win32', 'x64', 'diffle-windows-x64.zip'],
    ['win32', 'arm64', 'diffle-windows-arm64.zip'],
    ['freebsd', 'x64', null],
    ['linux', 'ia32', null],
  ] as const)('%s-%s: %s', (platform, arch, asset) => {
    expect(releaseAsset(platform, arch)).toBe(asset);
  });
});

describe('checksumFor', () => {
  it('reads text and binary mode lines', () => {
    const sums = 'aa  diffle-linux-x64.tar.gz\r\nbb *diffle-windows-x64.zip\n';
    expect(checksumFor(sums, 'diffle-linux-x64.tar.gz')).toBe('aa');
    expect(checksumFor(sums, 'diffle-windows-x64.zip')).toBe('bb');
    expect(checksumFor(sums, 'diffle-linux-arm64.tar.gz')).toBeNull();
  });
});

describe('installRelease', () => {
  const asset = 'diffle-linux-x64.tar.gz';
  const base = 'https://mirror.example/v0.2.0';

  /** A release whose "binary" is a shell script reporting `version`, served by a fake fetch. */
  async function release(version: string, sums?: (hash: string) => string) {
    const build = join(dir, 'build');
    await mkdir(build);
    await writeFile(join(build, 'diffle'), `#!/bin/sh\necho ${version}\n`);
    await writeFile(join(build, 'LICENSE'), 'license\n');
    execFileSync('tar', ['-czf', join(dir, asset), '-C', build, 'diffle', 'LICENSE']);
    const archive = await readFile(join(dir, asset));
    const hash = createHash('sha256').update(archive).digest('hex');
    const files = new Map<string, Buffer>([
      [`${base}/${asset}`, archive],
      [`${base}/SHA256SUMS`, Buffer.from(sums ? sums(hash) : `${hash}  ${asset}\n`)],
    ]);
    const request = async (url: string | URL | Request) => {
      const body = files.get(String(url));
      return body ? new Response(new Uint8Array(body)) : new Response('not found', { status: 404 });
    };
    return request as typeof fetch;
  }

  async function installed() {
    const bin = join(dir, 'bin');
    await mkdir(bin);
    const target = join(bin, 'diffle');
    await writeFile(target, '#!/bin/sh\necho 0.1.8\n');
    await chmod(target, 0o755);
    return target;
  }

  // A POSIX-shell script stands in for the binary, and Windows cannot run one.
  it.skipIf(process.platform === 'win32')('replaces the target once the new binary runs', async () => {
    const target = await installed();
    const request = await release('0.2.0');
    const opts = { target, tag: 'v0.2.0', platform: 'linux', arch: 'x64', base, request } as const;
    expect(await installRelease(opts)).toBe('0.2.0');
    expect(execFileSync(target, { encoding: 'utf8' })).toBe('0.2.0\n');
    expect(await readdir(join(dir, 'bin'))).toEqual(['diffle']);
  });

  it.skipIf(process.platform === 'win32')('leaves the target alone when a step fails', async () => {
    const target = await installed();
    const opts = { target, tag: 'v0.2.0', platform: 'linux', arch: 'x64', base } as const;
    const mismatch = await release('0.2.0', () => `${'0'.repeat(64)}  ${asset}\n`);
    await expect(installRelease({ ...opts, request: mismatch })).rejects.toThrow(`checksum mismatch for ${asset}`);
    await expect(
      installRelease({ ...opts, tag: 'v9.9.9', base: 'https://mirror.example/v9.9.9', request: mismatch }),
    ).rejects.toThrow('HTTP 404');
    await expect(installRelease({ ...opts, arch: 'ia32', request: mismatch })).rejects.toThrow('no release binary');
    expect(execFileSync(target, { encoding: 'utf8' })).toBe('0.1.8\n');
    expect(await readdir(join(dir, 'bin'))).toEqual(['diffle']);
  });
});

describe('replaceExecutable', () => {
  it('renames over the target, or on Windows moves the running one aside first', async () => {
    const target = join(dir, 'diffle.exe');
    const next = join(dir, 'next.exe');
    await writeFile(target, 'old');
    await writeFile(`${target}.old`, 'older');
    await writeFile(next, 'new');
    await replaceExecutable(target, next, 'win32');
    expect(await readFile(target, 'utf8')).toBe('new');
    expect(await readFile(`${target}.old`, 'utf8')).toBe('old');
    await writeFile(next, 'newer');
    await replaceExecutable(target, next, 'linux');
    expect(await readFile(target, 'utf8')).toBe('newer');
    expect((await readdir(dir)).sort()).toEqual(['diffle.exe', 'diffle.exe.old']);
  });
});
