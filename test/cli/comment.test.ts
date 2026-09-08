import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RunFile, isAlive } from '../../src/server/RunFile.js';
import type { CommentThread } from '../../src/shared/protocol.js';

const TSX = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const MAIN = join(process.cwd(), 'src', 'cli', 'main.ts');
const env = { ...process.env, NO_COLOR: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' };

let dir: string;
let gitDir: string;
const spawned: ChildProcess[] = [];
const detachedPids: number[] = [];

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the CLI to completion. */
function cli(args: string[], stdin?: string): Promise<Run> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [TSX, MAIN, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', rej);
    child.on('close', (code) => res({ code, stdout, stderr }));
    child.stdin.end(stdin ?? '');
  });
}

/**
 * Starts a foreground server and resolves once a run file newer than the launch
 * names a live pid. tsx re-spawns node, so the pid is not `child.pid`.
 */
async function startServer(args: string[]): Promise<{ child: ChildProcess; done: Promise<Run>; port: number }> {
  const since = Date.now();
  const child = spawn(process.execPath, [TSX, MAIN, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  spawned.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8').on('data', (d: string) => (stdout += d));
  child.stderr!.setEncoding('utf8').on('data', (d: string) => (stderr += d));
  const done = new Promise<Run>((res) => child.on('close', (code) => res({ code, stdout, stderr })));
  const rf = new RunFile(gitDir);
  const deadline = Date.now() + 30_000;
  for (;;) {
    const info = await rf.read();
    if (info && info.startedAt >= since) {
      // The real server pid, so a failing test still gets it killed in afterAll.
      detachedPids.push(info.pid);
      return { child, done, port: info.port };
    }
    if (child.exitCode != null) throw new Error(`server exited early (${child.exitCode}):\n${stderr}`);
    if (Date.now() > deadline) throw new Error(`server did not start:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'diffle-cli-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, env });
  git('init', '-q', '-b', 'main');
  await writeFile(join(dir, 'app.py'), 'def run():\n    return 1\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  await writeFile(join(dir, 'app.py'), 'def run():\n    return 2\n\ndef helper():\n    pass\n');
  gitDir = join(dir, '.git');
}, 60_000);

afterAll(async () => {
  for (const c of spawned) if (c.exitCode == null) c.kill('SIGKILL');
  for (const pid of detachedPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  await rm(dir, { recursive: true, force: true });
});

describe('agent loop over the CLI', () => {
  it('seeds findings with --comment, serves add/get/resolve, and prints only the open-thread prompt on exit', async () => {
    const finding = { path: 'app.py', startLine: 2, body: 'Why 2?' };
    const { child, done, port } = await startServer(['working', '--no-open', '--no-watch', '-p', '0', '-C', dir, '--comment', JSON.stringify(finding), '--as', 'claude']);

    const seeded = await cli(['comment', 'get', '--format', 'json', '-C', dir]);
    expect(seeded.code).toBe(0);
    const threads = JSON.parse(seeded.stdout) as CommentThread[];
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ anchor: { path: 'app.py', side: 'new', startLine: 2, endLine: 2, quoted: '    return 2' }, resolved: false });
    expect(threads[0]!.messages[0]).toMatchObject({ author: 'agent', authorName: 'claude', body: 'Why 2?' });

    // A duplicate of the seeded finding is skipped; a new one is added. Payload on stdin.
    const added = await cli(['comment', 'add', '@-', '-C', dir, '--as', 'claude'], JSON.stringify([finding, { path: 'app.py', startLine: 4, endLine: 5, body: 'Unused helper.' }]));
    expect(added.code).toBe(0);
    const summary = JSON.parse(added.stdout) as { added: number; skipped: number; threadIds: string[] };
    expect(summary).toMatchObject({ added: 1, skipped: 1 });
    expect(summary.threadIds).toHaveLength(1);

    // --url bypasses the run file; a wrong one is exit 1.
    const prompt = await cli(['comment', 'get', '--url', `http://127.0.0.1:${port}/`]);
    expect((await cli(['comment', 'get', '--url', 'http://127.0.0.1:1/'])).code).toBe(1);
    expect(prompt.stdout).toBe('app.py:2\n\n>     return 2\n\nWhy 2?\n\n---\n\napp.py:4-5\n\n> def helper():\n>     pass\n\nUnused helper.\n\n---\n');

    const replied = await cli(['comment', 'reply', threads[0]!.id, 'Fixed in the next round.', '--as', 'claude', '-C', dir]);
    expect(replied.code).toBe(0);
    expect((JSON.parse(replied.stdout) as CommentThread).messages.map((m) => [m.author, m.body])).toEqual([
      ['agent', 'Why 2?'],
      ['agent', 'Fixed in the next round.'],
    ]);
    expect((await cli(['comment', 'reply', 'bogus', 'x', '-C', dir])).code).toBe(1);

    const resolved = await cli(['comment', 'resolve', threads[0]!.id, 'bogus', '-C', dir]);
    expect(resolved.code).toBe(1);
    expect(JSON.parse(resolved.stdout)).toEqual({ resolved: [threads[0]!.id], notFound: ['bogus'] });
    expect((await cli(['comment', 'get', '--state', 'resolved', '-C', dir])).stdout).toContain('Why 2?');

    // Malformed payloads are usage errors.
    const bad = await cli(['comment', 'add', '-C', dir, '{not json']);
    expect(bad.code).toBe(2);
    expect(bad.stdout).toBe('');

    // The handoff: Ctrl+C prints the open threads, and nothing else, on stdout.
    child.kill('SIGINT');
    const run = await done;
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('app.py:4-5\n\n> def helper():\n>     pass\n\nUnused helper.\n\n---\n');
    expect(run.stderr).toContain('1 agent comment');
    expect(await new RunFile(gitDir).read()).toBeNull();

    const gone = await cli(['comment', 'get', '-C', dir]);
    expect(gone.code).toBe(1);
    expect(gone.stderr).toMatch(/no diffle server/);

    // Without a server the store still answers, in both shapes.
    expect((await cli(['export', 'working', '-C', dir])).stdout).toBe(run.stdout);
    const all = JSON.parse((await cli(['export', 'working', '--state', 'all', '--format', 'json', '-C', dir])).stdout) as CommentThread[];
    expect(all.map((t) => t.resolved).sort()).toEqual([false, true]);
  }, 90_000);

  it('rejects a bad --comment payload with exit 2 before serving', async () => {
    const r = await cli(['working', '--no-open', '--no-watch', '-p', '0', '-C', dir, '--comment', '{oops']);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/invalid comment JSON/);
    const unquotable = await cli(['working', '--no-open', '--no-watch', '-p', '0', '-C', dir, '--comment', JSON.stringify({ path: 'app.py', startLine: 99, body: 'x' })]);
    expect(unquotable.code).toBe(2);
    expect(unquotable.stderr).toMatch(/cannot quote app.py:99/);
    expect(await new RunFile(gitDir).read()).toBeNull();
  }, 60_000);

  it('--background detaches, prints the handshake, and stays reachable until killed', async () => {
    // One payload inline, one on stdin: the parent must read stdin itself, since the detached child has none.
    const r = await cli(
      ['working', '--background', '-p', '0', '--no-watch', '-C', dir, '--comment', JSON.stringify({ path: 'app.py', startLine: 1, body: 'From the background run.' }), '--comment', '-'],
      JSON.stringify({ path: 'app.py', startLine: 4, body: 'From stdin.' }),
    );
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    const handshake = JSON.parse(lines[0]!) as { port: number; url: string; pid: number };
    detachedPids.push(handshake.pid);
    expect(handshake.url).toContain(`:${handshake.port}/`);
    expect(isAlive(handshake.pid)).toBe(true);
    const info = await new RunFile(gitDir).read();
    expect(info).toMatchObject({ pid: handshake.pid, port: handshake.port, commentKey: 'working' });
    const get = await cli(['comment', 'get', '--format', 'json', '-C', dir]);
    expect(get.code).toBe(0);
    const bodies = (JSON.parse(get.stdout) as CommentThread[]).map((t) => t.messages[0]!.body);
    expect(bodies).toContain('From the background run.');
    expect(bodies).toContain('From stdin.');
    process.kill(handshake.pid, 'SIGTERM');
    const deadline = Date.now() + 10_000;
    while (isAlive(handshake.pid) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
    expect(isAlive(handshake.pid)).toBe(false);
    expect(await new RunFile(gitDir).read()).toBeNull();
    expect(await readFile(join(gitDir, 'diffle', 'server.log'), 'utf8')).toContain('diffle running at');
  }, 90_000);

  it('--background --comment - accepts a stdin payload larger than one argv string', async () => {
    // Linux caps a single argv string at 128 KiB (MAX_ARG_STRLEN); the parent must spool stdin to a file, not inline it.
    const body = 'x'.repeat(200_000);
    const r = await cli(['working', '--background', '-p', '0', '--no-watch', '-C', dir, '--comment', '-'], JSON.stringify([{ path: 'app.py', startLine: 1, body }]));
    expect(r.stderr).not.toMatch(/E2BIG/);
    expect(r.code).toBe(0);
    const handshake = JSON.parse(r.stdout.trim()) as { pid: number };
    detachedPids.push(handshake.pid);
    const get = await cli(['comment', 'get', '--format', 'json', '-C', dir]);
    expect((JSON.parse(get.stdout) as CommentThread[]).map((t) => t.messages[0]!.body)).toContain(body);
    // The child owns the spool file and deletes it once imported.
    expect((await readdir(join(gitDir, 'diffle'))).filter((f) => f.startsWith('comment-'))).toEqual([]);
    process.kill(handshake.pid, 'SIGTERM');
    const deadline = Date.now() + 10_000;
    while (isAlive(handshake.pid) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
    expect(isAlive(handshake.pid)).toBe(false);
  }, 90_000);
});
