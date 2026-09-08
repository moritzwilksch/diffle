import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const TSX = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const MAIN = join(process.cwd(), 'src', 'cli', 'main.ts');

describe('diffle --version', () => {
  it('prints the package version on stdout and exits 0', async () => {
    const pkg = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as { version: string };
    for (const flag of ['--version', '-v']) {
      const { stdout } = await run(process.execPath, [TSX, MAIN, flag], { env: { ...process.env, NO_COLOR: '1' } });
      expect(stdout.trim()).toBe(pkg.version);
    }
  }, 60_000);
});
