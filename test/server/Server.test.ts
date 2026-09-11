import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { rmTmp } from '../tmp.js';
import { GitRepo } from '../../src/server/git/GitRepo.js';
import { Server } from '../../src/server/Server.js';
import { LspPool } from '../../src/server/lsp/LspPool.js';
import type { ApiDeps } from '../../src/server/routes.js';
import { Session } from '../../src/server/Session.js';
import { UserConfigStore } from '../../src/server/UserConfig.js';
import { WsHub } from '../../src/server/ws.js';
import type { CommentThread } from '../../src/shared/protocol.js';
import { connect } from 'node:net';

let dir: string;
let server: Server;
let session: Session;
let base: URL;
let config: UserConfigStore;
let hub: WsHub;
let deps: ApiDeps;
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

interface Res {
  status: number;
  body: string;
}

/** node:http, not fetch: fetch drops a caller-set Host header. */
function send(
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<Res> {
  return new Promise((res, rej) => {
    const req = request(
      {
        host: base.hostname,
        port: base.port,
        method,
        path,
        headers: { 'content-type': 'application/json', connection: 'close', ...opts.headers },
      },
      (r) => {
        let body = '';
        r.setEncoding('utf8');
        r.on('data', (d: string) => (body += d));
        r.on('end', () => res({ status: r.statusCode ?? 0, body }));
      },
    );
    req.on('error', rej);
    req.end(opts.body);
  });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'diffle-server-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env });
  await writeFile(join(dir, 'a.txt'), 'a\n');
  execFileSync('git', ['add', '.'], { cwd: dir, env });
  execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: dir, env });
  const repo = await GitRepo.open(dir);
  hub = new WsHub();
  config = await UserConfigStore.open(join(dir, 'cfg', 'config.json'));
  session = new Session(repo, hub, { watch: false, context: 3 });
  deps = { session, config, extraAutoViewed: [], hub, lsp: null };
  server = new Server(deps, { port: 0, host: '127.0.0.1', allowedOrigin: 'https://proxy.example', dev: false });
  base = await server.listen();
  await session.start({ kind: 'working' });
});
afterAll(async () => {
  await server.close();
  await rmTmp(dir);
});

describe('Server', () => {
  it.each([
    ['POST', '/api/mode'],
    ['POST', '/api/patch'],
    ['POST', '/api/threads'],
    ['POST', '/api/threads/missing/replies'],
    ['PATCH', '/api/threads/missing/messages/missing'],
    ['PUT', '/api/threads/missing/resolved'],
    ['PUT', '/api/viewed'],
    ['PUT', '/api/viewed/bulk'],
    ['PUT', '/api/config'],
    ['POST', '/api/github/export'],
    ...['definition', 'type-definition', 'hover', 'token-kind', 'references'].map((name) => [
      'POST',
      `/api/lsp/${name}`,
    ]),
  ])('rejects malformed JSON and null at %s %s before side effects', async (method, path) => {
    const mode = session.mode;
    const before = config.get();
    const broadcast = vi.spyOn(hub, 'broadcast');
    const exportGithub = vi.spyOn(session, 'exportGithub');
    try {
      for (const body of ['{broken', 'null', '']) {
        const response = await send(method, path, { body });
        expect(response.status).toBe(400);
        expect(JSON.parse(response.body).error).toEqual(expect.any(String));
      }
      expect(session.mode).toEqual(mode);
      expect(config.get()).toEqual(before);
      expect(broadcast).not.toHaveBeenCalled();
      expect(exportGithub).not.toHaveBeenCalled();
    } finally {
      broadcast.mockRestore();
      exportGithub.mockRestore();
    }
  });

  it.each([
    ['POST', '/api/mode', { kind: 'revspec', args: [1] }],
    ['POST', '/api/patch', { paths: Array(201).fill('a.txt') }],
    ['PUT', '/api/config', { autoViewed: ['a', 1] }],
    ['PUT', '/api/config', { contextLines: -1 }],
    ['PUT', '/api/config', { contextLines: 1.5 }],
    ['PUT', '/api/config', { contextLines: 10001 }],
    ['PUT', '/api/viewed/bulk', { entries: [{ path: 'a', blob: '', viewed: true }, null] }],
    ['PUT', '/api/viewed', { path: 'a', blob: '', viewed: 'true' }],
    ['POST', '/api/github/export', { threadIds: [1] }],
    ['POST', '/api/threads/missing/replies', { body: '  ' }],
    ['PATCH', '/api/threads/missing/messages/missing', { body: 1 }],
    ['PUT', '/api/threads/missing/resolved', { resolved: 'false' }],
    ...['definition', 'type-definition', 'hover', 'token-kind', 'references'].flatMap((name) =>
      [1.5, 0, 9007199254740992].map((line): [string, string, unknown] => [
        'POST',
        `/api/lsp/${name}`,
        { path: 'a.ts', line, col: 0 },
      ]),
    ),
  ])('validates fields at %s %s', async (method, path, body) => {
    expect((await send(method, path, { body: JSON.stringify(body) })).status).toBe(400);
  });

  it.each([
    '/api/file?path=a.txt&rev=other',
    '/api/search?scope=other',
    '/api/search?word=true',
    '/api/threads?state=other',
    '/api/threads/export?state=other',
    '/api/lsp/symbols',
  ])('validates query parameters at %s', async (path) => {
    expect((await send('GET', path)).status).toBe(400);
  });

  it('does not clear threads for an invalid stale filter', async () => {
    const clear = vi.spyOn(session.comments, 'clear');
    const removeStale = vi.spyOn(session.comments, 'removeStale');
    try {
      expect((await send('DELETE', '/api/threads?stale=0')).status).toBe(400);
      expect(clear).not.toHaveBeenCalled();
      expect(removeStale).not.toHaveBeenCalled();
    } finally {
      clear.mockRestore();
      removeStale.mockRestore();
    }
  });

  it('serves repository identity as GitHub metadata', async () => {
    const snap = await session.snapshotter.current();
    expect(snap).not.toHaveProperty('githubRepository');
    const response = await send('GET', '/api/github');
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      version: snap.version,
      repository: null,
      pullRequest: null,
      reason: expect.any(String),
    });
    expect(session.mode).not.toHaveProperty('kind');
  });

  it('validates preview counts and returns the available endpoint messages', async () => {
    for (const count of ['', '-1', '1.5', 'nope', '9007199254740992']) {
      expect((await send('GET', '/api/last-commits-preview?newOffset=0&oldOffset=' + count)).status).toBe(400);
    }
    const response = await send('GET', '/api/last-commits-preview?oldOffset=1&newOffset=0');
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ old: null, new: { message: 'base' } });
  });

  it('serves the API to loopback hosts', async () => {
    const r = await send('GET', '/api/snapshot');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).mode.new).toBe('worktree');
  });

  it('returns a JSON error for unknown API routes instead of the app page', async () => {
    const response = await send('GET', '/api/unknown-endpoint');
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body).error).toContain('API endpoint not found');
  });

  it('creates a thread on the whole file from a payload without a line, and exports it without a quote', async () => {
    const created = await send('POST', '/api/threads', { body: JSON.stringify({ path: 'a.txt', body: 'Rename it.' }) });
    expect(created.status).toBe(201);
    const [thread] = JSON.parse(created.body) as CommentThread[];
    expect(thread).toMatchObject({ anchor: { kind: 'file', path: 'a.txt' }, stale: false });
    try {
      const r = await send('GET', '/api/threads/export');
      expect(r).toEqual({ status: 200, body: '(file) a.txt\n\nRename it.\n\n---\n' });
      const missing = await send('POST', '/api/threads', { body: JSON.stringify({ path: 'nope.txt', body: 'x' }) });
      expect(missing.status).toBe(400);
      expect(JSON.parse(missing.body).error).toContain('nope.txt');
    } finally {
      await session.comments.removeThread(thread!.id);
    }
  });

  it('exports one message with its thread context', async () => {
    const thread = await session.comments.addThread(
      { kind: 'line', path: 'a.txt', side: 'new', startLine: 1, endLine: 1, quoted: 'a' },
      { body: 'Check this.' },
    );
    try {
      const message = thread.messages[0]!;
      const r = await send('GET', `/api/threads/${thread.id}/messages/${message.id}/export`);
      expect(r).toEqual({ status: 200, body: 'a.txt:1\n\n> a\n\nCheck this.\n\n---\n' });
      expect((await send('GET', `/api/threads/${thread.id}/messages/missing/export`)).status).toBe(404);
    } finally {
      await session.comments.removeThread(thread.id);
    }
  });

  it('rejects foreign Host and mismatched Origin with 403', async () => {
    expect((await send('GET', '/api/snapshot', { headers: { host: 'evil.example' } })).status).toBe(403);
    expect((await send('GET', '/api/snapshot', { headers: { origin: 'http://evil.example' } })).status).toBe(403);
    expect((await send('GET', '/api/snapshot', { headers: { origin: base.origin } })).status).toBe(200);
  });

  it.each(['proxy.example', '127.0.0.1:4966'])('accepts proxied HTTP and WebSockets with Host %s', async (host) => {
    const headers = { host, origin: 'https://proxy.example' };
    expect((await send('GET', '/api/snapshot', { headers })).status).toBe(200);
    expect(
      (await send('GET', '/api/snapshot', { headers: { ...headers, origin: 'https://evil.example' } })).status,
    ).toBe(403);
    const ws = new WebSocket(base.href.replace('http:', 'ws:') + 'ws', { headers });
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
    } finally {
      ws.close();
      await vi.waitFor(() => expect(hub.clientCount).toBe(0));
    }
  });

  it('reports WebSocket clients joining and leaving', async () => {
    const counts: number[] = [];
    const unsubscribe = hub.onClientsChanged((count) => counts.push(count));
    const ws = new WebSocket(base.href.replace('http:', 'ws:') + 'ws');
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res());
      ws.once('error', rej);
    });
    expect(counts).toEqual([1]);
    ws.close();
    // The client's close event is not the server's; wait for the hub to see the disconnect.
    await vi.waitFor(() => expect(counts).toEqual([1, 0]));
    unsubscribe();
  });

  it('survives a malformed WebSocket frame and keeps serving', async () => {
    // A raw upgrade, then garbage instead of a frame: `ws` emits 'error' on the socket.
    await new Promise<void>((res, rej) => {
      const sock = connect(Number(base.port), base.hostname, () => {
        sock.write(
          `GET /ws HTTP/1.1\r\nHost: ${base.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      sock.once('data', () => {
        sock.write(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
      });
      sock.on('close', () => res());
      sock.on('error', rej);
    });
    expect((await send('GET', '/api/snapshot')).status).toBe(200);
  });

  it('POST /api/patch returns the listed files, skipping unknown ones, and rejects a malformed body', async () => {
    await writeFile(join(dir, 'a.txt'), 'a\nb\n');
    await writeFile(join(dir, 'n.txt'), 'n\n');
    // No watcher in this test: refresh by hand so the snapshot sees the writes.
    await session.refresh();
    try {
      const r = await send('POST', '/api/patch', {
        body: JSON.stringify({ paths: ['a.txt', 'n.txt', 'missing.txt'] }),
      });
      expect(r.status).toBe(200);
      expect(r.body).toContain('+++ b/a.txt');
      expect(r.body).toContain('+++ b/n.txt');
      expect(r.body).not.toContain('missing.txt');
      const one = await send('POST', '/api/patch', { body: JSON.stringify({ paths: ['n.txt'] }) });
      expect(one.body).toContain('+++ b/n.txt');
      expect(one.body).not.toContain('a.txt');
      expect((await send('POST', '/api/patch', { body: JSON.stringify({ paths: 'a.txt' }) })).status).toBe(400);
    } finally {
      await writeFile(join(dir, 'a.txt'), 'a\n');
      await rm(join(dir, 'n.txt'));
      await session.refresh();
    }
  });

  it('GET /api/search covers only the diff unless scope=repo, or one file with scope=file', async () => {
    await writeFile(join(dir, 'a.txt'), 'a\nneedle\n');
    await writeFile(join(dir, 'n.txt'), 'needle\n');
    // n.txt is committed, so it is in the tree but not in the working diff.
    execFileSync('git', ['add', 'n.txt'], { cwd: dir, env });
    execFileSync('git', ['commit', '-q', '-m', 'unchanged file'], { cwd: dir, env });
    await session.refresh();
    try {
      const paths = async (qs: string) =>
        (JSON.parse((await send('GET', `/api/search?${qs}`)).body).matches as { path: string }[]).map((m) => m.path);
      expect(await paths('q=needle')).toEqual(['a.txt']);
      expect(await paths('q=needle&scope=diff')).toEqual(['a.txt']);
      expect(await paths('q=needle&scope=repo')).toEqual(['a.txt', 'n.txt']);
      expect(await paths('q=needle&scope=file&path=n.txt')).toEqual(['n.txt']);
      // A file outside the new side matches nothing rather than widening to everything.
      expect(await paths('q=needle&scope=file&path=missing.txt')).toEqual([]);
      expect(await paths('q=needle&scope=file')).toEqual([]);
    } finally {
      await writeFile(join(dir, 'a.txt'), 'a\n');
      await session.refresh();
    }
  });

  it.each(['content-length', 'chunked'])('rejects oversized %s bodies with 413', async (framing) => {
    const before = config.get();
    const body = JSON.stringify({ autoViewed: ['x'.repeat(2 * 1024 * 1024)] });
    const headers: Record<string, string> =
      framing === 'chunked'
        ? { 'transfer-encoding': 'chunked' }
        : { 'content-length': String(Buffer.byteLength(body)) };
    const r = await send('PUT', '/api/config', { body, headers });
    expect(r.status).toBe(413);
    expect(JSON.parse(r.body)).toEqual({ error: 'request body too large' });
    expect(config.get()).toEqual(before);
    expect((await send('GET', '/api/snapshot')).status).toBe(200);
  });

  it('GET /api/file serves a file outside the snapshot only after the language server named it', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'diffle-site-'));
    const site = join(outside, 'site.py');
    const secret = join(outside, 'secret.py');
    await writeFile(site, 'import sys\n');
    await writeFile(secret, 'token = 1\n');
    const file = (path: string, rev = 'new') => send('GET', `/api/file?path=${encodeURIComponent(path)}&rev=${rev}`);
    try {
      await writeFile(join(dir, 'source.py'), 'import sys\n');
      await session.refresh();
      deps.lsp = new LspPool({
        overrides: { python: 'fake' },
        preload: ['python'],
        lookup: (command) => command,
        root: dir,
        read: async (p) => (await session.readSide(await session.snapshotter.current(), p, 'new'))?.toString() ?? null,
        has: async (p) => session.hasSide(await session.snapshotter.current(), p, 'new'),
        onStatus: () => {},
        spawnProcess: () =>
          spawn(process.execPath, [join(import.meta.dirname, '..', 'lsp', 'fake-lsp.mjs')], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, FAKE_LSP_ROOT: dir, FAKE_LSP_EXTERNAL: site },
          }),
      });
      expect((await file(site)).status).toBe(404);
      const def = await send('POST', '/api/lsp/definition', {
        body: JSON.stringify({ path: 'source.py', line: 1, col: 0 }),
      });
      expect(def.status).toBe(200);
      expect(JSON.parse(def.body).locations).toContainEqual({
        path: site,
        line: 1,
        col: 0,
        text: 'import sys',
        external: true,
      });
      const served = await file(site);
      expect(served.status).toBe(200);
      expect(JSON.parse(served.body)).toEqual({ path: site, contents: 'import sys\n', binary: false });
      // Only the new side, and only paths the server returned: a neighbour file stays unreadable.
      expect((await file(site, 'old')).status).toBe(404);
      expect((await file(secret)).status).toBe(404);
    } finally {
      await deps.lsp?.close();
      deps.lsp = null;
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('ignores lspCommands on PUT /api/config', async () => {
    const before = config.get().lspCommands;
    const r = await send('PUT', '/api/config', {
      body: JSON.stringify({ lspCommands: { python: 'rm -rf /' }, contextLines: 7 }),
    });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).lspCommands).toEqual(before);
    expect(config.get()).toMatchObject({ lspCommands: before, contextLines: 7 });
  });

  // Windows has no POSIX mode bits to check.
  it.skipIf(process.platform === 'win32')('writes the config file and its directory owner-only', async () => {
    await send('PUT', '/api/config', { body: JSON.stringify({ contextLines: 7 }) });
    expect((await stat(config.file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'cfg'))).mode & 0o777).toBe(0o700);
  });
});
