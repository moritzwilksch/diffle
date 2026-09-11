import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TSX = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const MAIN = join(process.cwd(), 'src', 'cli', 'main.ts');

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'diffle-usage-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

/** Runs the CLI to completion, with its own config directory so no real config is touched. */
function cli(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((res, rej) => {
    const env = { ...process.env, NO_COLOR: '1', XDG_CONFIG_HOME: dir };
    const child = spawn(process.execPath, [TSX, MAIN, ...args], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', rej);
    child.on('close', (code) => res({ code, stderr }));
  });
}

// Every bad argument has to say what was wrong with it: a parser that throws where commander
// cannot report it leaves nothing behind but the exit code.
describe('usage errors', () => {
  it('names the unknown language for config unset-lsp', async () => {
    const run = await cli(['config', 'unset-lsp', 'python', 'nope']);
    expect(run.stderr).toContain("command-argument value 'nope' is invalid");
    expect(run.stderr).toContain('unknown language "nope"');
    expect(run.code).toBe(2);
  }, 30_000);

  it('names the unknown language for config set-lsp', async () => {
    const run = await cli(['config', 'set-lsp', 'nope', 'x']);
    expect(run.stderr).toContain('unknown language "nope"');
    expect(run.code).toBe(2);
  }, 30_000);

  it('rejects --lsp without a value rather than dropping the overrides before it', async () => {
    const run = await cli(['working', '--no-open', '--no-watch', '--lsp', 'python=x', '--lsp']);
    expect(run.stderr).toContain("option '--lsp <language=command>' argument missing");
    expect(run.code).toBe(2);
  }, 30_000);

  it('names the language whose --lsp value is malformed', async () => {
    const run = await cli(['working', '--no-open', '--no-watch', '--lsp', 'nope=x']);
    expect(run.stderr).toContain('unknown language "nope"');
    expect(run.code).toBe(2);
  }, 30_000);
});
