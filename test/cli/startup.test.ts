import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** True while the pid names a live process; EPERM means it exists but is someone else's. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const TSX = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const MAIN = join(process.cwd(), 'src', 'cli', 'main.ts');
const env = { ...process.env, NO_COLOR: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' };

let dir: string;
let blocker: Server;
let port: number;

/** Runs the CLI to completion. */
function cli(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [TSX, MAIN, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', rej);
    child.on('close', (code) => res({ code, stderr }));
  });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'diffle-startup-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, env });
  git('init', '-q', '-b', 'main');
  await writeFile(join(dir, 'app.py'), 'x = 1\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  blocker = createServer();
  await new Promise<void>((res) => blocker.listen(0, '127.0.0.1', res));
  port = (blocker.address() as { port: number }).port;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((res) => blocker.close(() => res()));
  await rm(dir, { recursive: true, force: true });
});

describe('failed startup', () => {
  it('leaves no LSP child behind when the requested port is taken', async () => {
    // A server that survives its stdin closing: only a signal ends it.
    const pidFile = join(dir, 'lsp.pid');
    const lsp = `echo $$ > "${pidFile}"; exec "${process.execPath}" -e "setInterval(() => {}, 1e6)"`;
    const run = await cli(['working', '--no-open', '--no-watch', '-C', dir, '-p', String(port), '--lsp', lsp]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('EADDRINUSE');

    // The shell writes its pid well within the bridge's shutdown grace, so the pid is always there.
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    expect(pid).toBeGreaterThan(0);
    try {
      expect(isAlive(pid)).toBe(false);
    } finally {
      if (isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
  }, 30_000);
});
