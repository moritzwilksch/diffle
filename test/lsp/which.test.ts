import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { argv0, findOnPath } from '../../src/server/lsp/which.js';

let dir: string;
let bin: string;
let other: string;
let env: NodeJS.ProcessEnv;

/** An executable file, or a plain one when `mode` says so. */
function file(at: string, mode = 0o755): string {
  writeFileSync(at, '#!/bin/sh\nexit 0\n');
  chmodSync(at, mode);
  return at;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'diffle-which-'));
  bin = join(dir, 'bin');
  other = join(dir, 'other');
  mkdirSync(bin);
  mkdirSync(other);
  file(join(bin, 'gopls'));
  file(join(other, 'gopls'));
  file(join(bin, 'notexec'), 0o644);
  mkdirSync(join(bin, 'adirectory'));
  env = { PATH: [bin, other, ''].join(delimiter) };
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('argv0', () => {
  it('takes the program from a command line, quotes and arguments aside', () => {
    expect(argv0('gopls')).toBe('gopls');
    expect(argv0('  pyrefly lsp  ')).toBe('pyrefly');
    expect(argv0('typescript-language-server --stdio')).toBe('typescript-language-server');
    expect(argv0('"/opt/my tools/pyrefly" lsp')).toBe('/opt/my tools/pyrefly');
    expect(argv0("'/opt/my tools/ty' server")).toBe('/opt/my tools/ty');
    expect(argv0('')).toBe('');
  });
});

describe('findOnPath', () => {
  it('returns the first executable file on PATH and skips what cannot run', () => {
    expect(findOnPath('gopls', env)).toBe(join(bin, 'gopls'));
    expect(findOnPath('gopls --extra', env)).toBe(join(bin, 'gopls'));
    expect(findOnPath('missing-server', env)).toBeNull();
    // A directory is not a program, even under the right name.
    expect(findOnPath('adirectory', env)).toBeNull();
    expect(findOnPath('', env)).toBeNull();
    expect(findOnPath('gopls', {})).toBeNull();
  });

  // Windows has no execute bit, so `runnable` accepts any regular file there by design.
  it.skipIf(process.platform === 'win32')('skips a file that is not executable', () => {
    expect(findOnPath('notexec', env)).toBeNull();
  });

  it('resolves a name with a separator against cwd instead of searching PATH', () => {
    expect(findOnPath('./gopls lsp', env, bin)).toBe(join(bin, 'gopls'));
    expect(findOnPath(join(other, 'gopls'), env, bin)).toBe(join(other, 'gopls'));
    // Relative to somewhere without it: a shell would not find it either.
    expect(findOnPath('./gopls', env, dir)).toBeNull();
  });
});
