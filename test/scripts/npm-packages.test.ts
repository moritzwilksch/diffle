import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TARGETS, assemble, smoke } from '../../scripts/npm-packages.js';
import { rmTmp } from '../tmp.js';

const version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
const host = Object.entries(TARGETS).find(([, p]) => p.os === process.platform && p.cpu === process.arch)?.[0];

/** A release archive for `target` whose "binary" is a script answering `--version` with the package version. */
function archive(dir: string, target: string): void {
  const stage = join(dir, `stage-${target}`);
  mkdirSync(stage);
  writeFileSync(join(stage, 'diffle'), `#!/bin/sh\n[ "$1" = --version ] && echo ${version}\n`);
  chmodSync(join(stage, 'diffle'), 0o755);
  writeFileSync(join(stage, 'LICENSE'), 'license\n');
  writeFileSync(join(stage, 'THIRD_PARTY_NOTICES.md'), 'notices\n');
  execFileSync('tar', [
    '-czf',
    join(dir, `diffle-${target}.tar.gz`),
    '-C',
    stage,
    'diffle',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
  ]);
}

describe.skipIf(process.platform === 'win32')('npm packages', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'diffle-npm-test-'));
  });
  afterEach(() => rmTmp(dir));

  it('writes one package per archive present and a launcher that wants them all optionally', () => {
    archive(dir, 'x86_64-unknown-linux-gnu');
    archive(dir, 'aarch64-apple-darwin');
    const out = join(dir, 'out');
    expect(assemble(dir, out)).toEqual({ version, built: ['diffle-linux-x64', 'diffle-darwin-arm64'] });
    const manifest = (name: string) => JSON.parse(readFileSync(join(out, name, 'package.json'), 'utf8'));
    expect(manifest('diffle-linux-x64')).toMatchObject({
      name: '@moritzwilksch/diffle-linux-x64',
      version,
      os: ['linux'],
      cpu: ['x64'],
    });
    expect(readFileSync(join(out, 'diffle-linux-x64', 'diffle'), 'utf8')).toContain('--version');
    const launcher = manifest('diffle');
    expect(launcher).toMatchObject({ name: '@moritzwilksch/diffle', version, bin: { diffle: 'bin/diffle.js' } });
    expect(Object.keys(launcher.optionalDependencies)).toEqual([
      '@moritzwilksch/diffle-linux-x64',
      '@moritzwilksch/diffle-linux-arm64',
      '@moritzwilksch/diffle-darwin-arm64',
      '@moritzwilksch/diffle-win32-x64',
      '@moritzwilksch/diffle-win32-arm64',
    ]);
    expect(new Set(Object.values(launcher.optionalDependencies))).toEqual(new Set([version]));
    for (const file of ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'bin/diffle.js']) {
      expect(readFileSync(join(out, 'diffle', file), 'utf8').length).toBeGreaterThan(0);
    }
  });

  it.skipIf(!host)("the launcher finds and runs this platform's binary", () => {
    archive(dir, host!);
    const out = join(dir, 'out');
    assemble(dir, out);
    expect(smoke(out, version)).toBe(version);
  });

  it('the launcher names the missing platform package when there is none', () => {
    const out = join(dir, 'out');
    assemble(dir, out);
    const run = () =>
      execFileSync(process.execPath, [join(out, 'diffle', 'bin', 'diffle.js'), '--version'], { stdio: 'pipe' });
    expect(run).toThrow(new RegExp(`diffle-${process.platform}-${process.arch} is not installed`));
  });
});
