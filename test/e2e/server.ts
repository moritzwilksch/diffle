import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { rmTmp } from '../tmp.js';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommentThread, ThreadCreate } from '../../src/shared/protocol.js';

/** The diffle checkout that contains this file. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** The client build the server serves. Swap it to screenshot a different build. */
export const CLIENT_DIR = join(REPO_ROOT, 'dist/client');

export interface DiffleOptions {
  /** The repository to review; any directory inside a worktree. */
  repo: string;
  /** Revisions or a shorthand, as on the command line. */
  revs?: string[];
  /** Further CLI flags. */
  args?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface RunningDiffle {
  url: string;
  proc: ChildProcess;
  stop(): Promise<void>;
}

/**
 * Start diffle on `repo` for `revs`, with status noise off. Resolves once stderr names the
 * URL. Call `stop` (or use `withDiffle`) to reap the process.
 */
export async function startDiffle({
  repo,
  revs = [],
  args = [],
  env = {},
  timeoutMs = 30000,
}: DiffleOptions): Promise<RunningDiffle> {
  const configDir = await mkdtemp(join(tmpdir(), 'diffle-e2e-config-'));
  const proc = spawn(
    process.execPath,
    [
      join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'),
      join(REPO_ROOT, 'src/cli/main.ts'),
      '-C',
      repo,
      '--port',
      '0',
      '--no-open',
      '--no-watch',
      ...(args.some((a) => a.startsWith('--lsp')) ? [] : ['--no-lsp']),
      ...revs,
      ...args,
    ],
    {
      cwd: REPO_ROOT,
      // Every server owns its settings, including writes made through the settings dialog.
      env: { ...process.env, NO_COLOR: '1', ...env, XDG_CONFIG_HOME: configDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  let stdout = '';
  proc.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk;
  });
  proc.stdout!.on('data', (chunk: Buffer) => {
    stdout += chunk;
  });

  const url = await new Promise<string>((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error(`diffle did not start in ${timeoutMs}ms\n${stderr}`)), timeoutMs);
    const scan = () => {
      const match = stderr.match(/diffle running at (\S+)/);
      if (!match) return;
      clearTimeout(timer);
      resolveUrl(match[1] ?? '');
    };
    proc.stderr!.on('data', scan);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`diffle exited (${code})\n${stderr}\n${stdout}`));
    });
    scan();
  }).catch(async (error: unknown) => {
    proc.kill('SIGKILL');
    await rmTmp(configDir);
    throw error;
  });

  return {
    url,
    proc,
    async stop() {
      proc.kill('SIGTERM');
      await new Promise<void>((done) => {
        const force = setTimeout(() => {
          proc.kill('SIGKILL');
          done();
        }, 5000);
        proc.once('exit', () => {
          clearTimeout(force);
          done();
        });
      });
      await rmTmp(configDir);
    },
  };
}

/** Run `fn` with a freshly started diffle, always stopping it afterwards. */
export async function withDiffle<T>(opts: DiffleOptions, fn: (server: RunningDiffle) => Promise<T>): Promise<T> {
  const server = await startDiffle(opts);
  try {
    return await fn(server);
  } finally {
    await server.stop();
  }
}

/** Create threads directly: everything the sidebar shows is HTTP state, not UI state. */
export async function seedThreads(url: string, threads: ThreadCreate[]): Promise<CommentThread[]> {
  const response = await fetch(new URL('api/threads', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(threads),
  });
  if (!response.ok) throw new Error(`seeding threads failed: HTTP ${response.status} ${await response.text()}`);
  return (await response.json()) as CommentThread[];
}

/** Threads as the client sees them, for asserting that a comment landed where the script meant it to. */
export async function readThreads(url: string): Promise<CommentThread[]> {
  const response = await fetch(new URL('api/threads', url));
  if (!response.ok) throw new Error(`reading threads failed: HTTP ${response.status} ${await response.text()}`);
  return (await response.json()) as CommentThread[];
}

/** Wait until every language server diffle started reports ready, so a hover gets an answer. */
export async function waitForLsp(url: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await fetch(new URL('api/lsp/status', url));
    const status = (await response.json()) as { servers: { state: string }[] };
    if (status.servers.length > 0 && status.servers.every((s) => s.state === 'ready')) return;
    if (Date.now() > deadline) throw new Error(`language servers not ready: ${JSON.stringify(status)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The prompt the open comments export as, the text `yy` copies. */
export async function readPrompt(url: string): Promise<string> {
  const response = await fetch(new URL('api/threads/export?state=open', url));
  if (!response.ok) throw new Error(`reading the prompt failed: HTTP ${response.status} ${await response.text()}`);
  return response.text();
}

/**
 * Delete the review state (viewed, collapsed, threads) that diffle keeps under `<git-dir>/diffle/`.
 * Call before a take: a stale viewed or collapsed flag silently changes what the recording shows.
 */
export function resetReviewState(repo: string): void {
  const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: repo, encoding: 'utf8' }).trim();
  rmSync(join(resolve(repo, gitDir), 'diffle'), { recursive: true, force: true });
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** Build the client in this checkout. Run once per source revision. */
export function buildClient(cwd = REPO_ROOT): void {
  execFileSync(npm, ['run', 'build:client'], { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
}
