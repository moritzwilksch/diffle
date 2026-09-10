import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const TSX = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const MAIN = join(process.cwd(), 'src', 'cli', 'main.ts');

function completion(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return run(process.execPath, [TSX, MAIN, 'completion', ...args], {
    env: { ...process.env, NO_COLOR: '1' },
  });
}

describe('diffle completion', () => {
  // The script is standalone: whatever the command tree holds has to be in its text, because
  // nothing runs diffle at completion time to ask.
  it.each(['bash', 'zsh', 'fish'])(
    'writes a %s script carrying the commands, options, and choices',
    async (shell) => {
      const { stdout } = await completion('--shell', shell);
      expect(stdout).toContain('diffle');
      expect(stdout).toContain('config');
      expect(stdout).toContain('--keep-alive');
      // The shorthands are hidden commands; the revision argument's choices offer them anyway.
      expect(stdout).toContain('working');
      // Languages are a static choice list, so they complete without a config lookup.
      expect(stdout).toContain('typescriptreact');
    },
    30_000,
  );

  it('names the shells it knows when given another one', async () => {
    const failure = await completion('--shell', 'nope').catch((e: Error & { code?: number; stderr?: string }) => e);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as { stderr?: string }).stderr).toContain('bash, zsh, fish');
  }, 30_000);

  it('asks for a shell rather than guessing one', async () => {
    const failure = await completion().catch((e: Error & { stderr?: string }) => e);
    expect((failure as { stderr?: string }).stderr).toContain("required option '-s, --shell <shell>' not specified");
  }, 30_000);
});
