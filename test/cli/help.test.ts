import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const TSX = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const MAIN = join(process.cwd(), 'src', 'cli', 'main.ts');
const env = { ...process.env, NO_COLOR: '1' };

/** Runs the CLI to completion and captures both streams. */
function cli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [TSX, MAIN, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', rej);
    child.on('close', (code) => res({ code, stdout, stderr }));
  });
}

describe('diffle with no arguments', () => {
  // Issue #36: never default to a review; behave exactly like `--help`.
  it('prints the same help as --help and exits 0', async () => {
    const [bare, help] = await Promise.all([cli([]), cli(['--help'])]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Usage: diffle [options] [command] [revs...]');
    expect(bare.code).toBe(0);
    expect(bare.stdout).toBe(help.stdout);
    expect(bare.stderr).toBe('');
  }, 30_000);
});
