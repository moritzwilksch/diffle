import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { rmTmp } from '../tmp.js';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommentThread, ThreadCreate } from '../../src/shared/protocol.js';

/** The diffle checkout that contains this file. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export interface DiffleOptions {
  /** The repository to review; any directory inside a worktree. */
  repo: string;
  /** Revisions or a shorthand, as on the command line. */
  revs?: string[];
  /** Further CLI flags. */
  args?: string[];
  env?: NodeJS.ProcessEnv;
  /** The diffle checkout to run, server and client; this one by default. See `baseCheckout`. */
  root?: string;
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
  root = REPO_ROOT,
  timeoutMs = 30000,
}: DiffleOptions): Promise<RunningDiffle> {
  const configDir = await mkdtemp(join(tmpdir(), 'diffle-e2e-config-'));
  const proc = spawn(
    process.execPath,
    [
      join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'),
      join(root, 'src/cli/main.ts'),
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
      cwd: root,
      // Every server owns its settings, including writes made through the settings dialog. No
      // scenario asks GitHub for a release unless it points the check at a stub of its own.
      env: { ...process.env, NO_COLOR: '1', DIFFLE_NO_UPDATE_CHECK: '1', ...env, XDG_CONFIG_HOME: configDir },
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

/** Run a command with its output captured; on failure, throw with the output's tail. */
export function quiet(cmd: string, args: string[], cwd = REPO_ROOT): string {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32' && cmd === npm,
    });
  } catch (error) {
    const { stdout = '', stderr = '' } = error as { stdout?: string; stderr?: string };
    const tail = `${stdout}${stderr}`.trim().split('\n').slice(-30).join('\n');
    throw new Error(`${cmd} ${args.join(' ')} failed\n${tail}`);
  }
}

/** Inputs of the client build; a change to any of them makes `dist/client` stale. */
const CLIENT_INPUTS = ['src/client', 'src/shared', 'vite.config.ts', 'tsconfig.client.json', 'package-lock.json'];

function clientInputsKey(root: string): string {
  const hash = createHash('sha256');
  const walk = (path: string): void => {
    if (!existsSync(path)) return;
    const st = statSync(path);
    if (!st.isDirectory()) {
      hash.update(`${relative(root, path)}\0${st.size}\0${st.mtimeMs}\n`);
      return;
    }
    for (const name of readdirSync(path).sort()) walk(join(path, name));
  };
  for (const input of CLIENT_INPUTS) walk(join(root, input));
  return hash.digest('hex');
}

/**
 * Build `cwd`'s client unless `dist/client` already matches its sources. Output appears only on
 * failure. Returns whether it built.
 */
export function buildClient(cwd = REPO_ROOT): boolean {
  const stamp = join(cwd, 'dist/client/.build-stamp');
  const key = clientInputsKey(cwd);
  if (existsSync(stamp) && readFileSync(stamp, 'utf8') === key) return false;
  quiet(npm, ['run', 'build:client'], cwd);
  writeFileSync(stamp, key);
  return true;
}
