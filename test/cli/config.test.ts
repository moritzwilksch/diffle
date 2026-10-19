import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const TSX = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const MAIN = join(process.cwd(), 'src', 'cli', 'main.ts');

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'diffle-config-cli-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

/** The config command against a throwaway config directory, returning its stdout. */
async function config(...args: string[]): Promise<string> {
  const { stdout } = await run(process.execPath, [TSX, MAIN, 'config', ...args], {
    env: { ...process.env, NO_COLOR: '1', XDG_CONFIG_HOME: dir },
  });
  return stdout;
}

describe('diffle config set-lsp / unset-lsp', () => {
  it('sets one language at a time and unsets every language it is given', async () => {
    await config('set-lsp', 'python', 'my-py-server');
    expect(await config('set-lsp', 'go', 'my-go-server')).toBe('python=my-py-server\ngo=my-go-server\n');
    // Both languages have to leave: commander folds a variadic parser, so a parser that
    // returned one language would silently keep the others.
    expect(await config('unset-lsp', 'python', 'go')).toBe('');
    expect(JSON.parse(await readFile(join(dir, 'diffle', 'config.json'), 'utf8')).lspCommands).toEqual({});
  }, 30_000);
});
