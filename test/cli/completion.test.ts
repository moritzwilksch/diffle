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
    'writes a %s script carrying the argument choices',
    async (shell) => {
      const { stdout } = await completion('--shell', shell);
      // The shorthands are hidden commands; the revision argument's choices offer them anyway.
      expect(stdout).toContain('working');
      // Languages are a static choice list, so they complete without a config lookup.
      expect(stdout).toContain('typescriptreact');
    },
    30_000,
  );
});
