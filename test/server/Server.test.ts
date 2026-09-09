import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmTmp } from '../tmp.js';
import { GitRepo } from '../../src/server/git/GitRepo.js';
import { Server } from '../../src/server/Server.js';
import { Session } from '../../src/server/Session.js';
import { UserConfigStore } from '../../src/server/UserConfig.js';
import { WsHub } from '../../src/server/ws.js';
import { connect } from 'node:net';

let dir: string;
let server: Server;
let session: Session;
let base: URL;
let config: UserConfigStore;
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' };

interface Res {
  status: number;
  body: string;
}

/** node:http, not fetch: fetch drops a caller-set Host header. */
function send(method: string, path: string, opts: { headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((res, rej) => {
    const req = request(
      { host: base.hostname, port: base.port, method, path, headers: { 'content-type': 'application/json', connection: 'close', ...opts.headers } },
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
  const hub = new WsHub();
  config = await UserConfigStore.open(join(dir, 'cfg', 'config.json'));
  session = new Session(repo, hub, { watch: false, context: 3 });
  server = new Server({ session, config, extraAutoViewed: [], hub, lsp: null }, { port: 0, host: '127.0.0.1', dev: false });
  base = await server.listen();
  await session.start({ kind: 'working' });
});
afterAll(async () => {
  await server.close();
  await rmTmp(dir);
});

describe('Server', () => {
  it('serves the API to loopback hosts', async () => {
    const r = await send('GET', '/api/snapshot');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).mode.kind).toBe('working');
  });

  it('rejects foreign Host and mismatched Origin with 403', async () => {
    expect((await send('GET', '/api/snapshot', { headers: { host: 'evil.example' } })).status).toBe(403);
    expect((await send('GET', '/api/snapshot', { headers: { origin: 'http://evil.example' } })).status).toBe(403);
    expect((await send('GET', '/api/snapshot', { headers: { origin: base.origin } })).status).toBe(200);
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
      const r = await send('POST', '/api/patch', { body: JSON.stringify({ paths: ['a.txt', 'n.txt', 'missing.txt'] }) });
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
      const paths = async (qs: string) => (JSON.parse((await send('GET', `/api/search?${qs}`)).body).matches as { path: string }[]).map((m) => m.path);
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
    const headers: Record<string, string> = framing === 'chunked'
      ? { 'transfer-encoding': 'chunked' }
      : { 'content-length': String(Buffer.byteLength(body)) };
    const r = await send('PUT', '/api/config', { body, headers });
    expect(r.status).toBe(413);
    expect(JSON.parse(r.body)).toEqual({ error: 'request body too large' });
    expect(config.get()).toEqual(before);
    expect((await send('GET', '/api/snapshot')).status).toBe(200);
  });

  it('ignores lspCommand on PUT /api/config', async () => {
    const before = config.get().lspCommand;
    const r = await send('PUT', '/api/config', { body: JSON.stringify({ lspCommand: 'rm -rf /', contextLines: 7 }) });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).lspCommand).toBe(before);
    expect(config.get()).toMatchObject({ lspCommand: before, contextLines: 7 });
  });

  // Windows has no POSIX mode bits to check.
  it.skipIf(process.platform === 'win32')('writes the config file and its directory owner-only', async () => {
    await send('PUT', '/api/config', { body: JSON.stringify({ contextLines: 7 }) });
    expect((await stat(config.file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'cfg'))).mode & 0o777).toBe(0o700);
  });
});
