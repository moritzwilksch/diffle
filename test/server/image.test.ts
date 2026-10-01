import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmTmp } from '../tmp.js';
import { GitRepo } from '../../src/server/git/GitRepo.js';
import { imageType } from '../../src/server/image.js';
import { imageKey, type Side } from '../../src/shared/protocol.js';
import { createApi } from '../../src/server/routes.js';
import { Session } from '../../src/server/Session.js';
import { UserConfigStore } from '../../src/server/UserConfig.js';
import { WsHub } from '../../src/server/ws.js';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (tag: number) => Buffer.from([...PNG, 0, 0, 0, tag]);

describe('imageType', () => {
  it.each([
    ['image/png', png(1)],
    ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])],
    ['image/gif', Buffer.from('GIF89a\0\0')],
    ['image/webp', Buffer.from('RIFF\x10\0\0\0WEBPVP8 ', 'latin1')],
    ['image/avif', Buffer.from('\0\0\0\x1cftypavif', 'latin1')],
    ['image/bmp', Buffer.from('BM\0\0')],
    ['image/x-icon', Buffer.from([0, 0, 1, 0, 1])],
  ])('reads %s from the leading bytes', (type, buf) => {
    expect(imageType(buf)).toBe(type);
  });

  it('refuses bytes that are no image, whatever they start like', () => {
    expect(imageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(imageType(Buffer.from([0, 1, 2, 3, 0]))).toBeNull();
    expect(imageType(Buffer.from(PNG.slice(0, 4)))).toBeNull();
    expect(imageType(Buffer.alloc(0))).toBeNull();
  });
});

describe('GET /api/image', () => {
  let dir: string;
  let session: Session;
  let app: ReturnType<typeof createApi>;
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    })
      .toString()
      .trim();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'diffle-image-'));
    git('init', '-q', '-b', 'main');
    await writeFile(join(dir, 'logo.png'), png(1));
    await writeFile(join(dir, 'before.png'), png(3));
    await writeFile(join(dir, 'still.png'), png(5));
    await writeFile(join(dir, 'blob.png'), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(dir, '.gitignore'), 'ignored.png\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'feat');
    await writeFile(join(dir, 'logo.png'), png(2));
    git('mv', 'before.png', 'after.png');
    git('commit', '-q', '-am', 'change');
    await writeFile(join(dir, 'ignored.png'), png(4));
    const hub = new WsHub();
    session = new Session(await GitRepo.open(dir), hub, { watch: false, context: 3 });
    const config = await UserConfigStore.open(join(dir, '.git', 'cfg', 'config.json'));
    app = createApi({ session, config, extraAutoViewed: [], hub, lsp: null });
  });
  afterAll(async () => {
    await session.close();
    await rmTmp(dir);
  });

  const image = (path: string, rev: Side, key: string | null) =>
    app.request(`/api/image?${new URLSearchParams({ path, rev, key: key ?? '' }).toString()}`);
  /** Requests a side under the key the current snapshot gives it, as the client does. */
  const current = async (path: string, rev: Side) =>
    image(path, rev, imageKey(await session.snapshotter.current(), path, rev));
  const bytes = async (res: Response) => Buffer.from(await res.arrayBuffer());
  /**
   * Starts a mode and waits out the snapshot's patch prewarm: on Windows a `git diff` still
   * reading a worktree file makes rewriting it fail.
   */
  const start = async (...spec: Parameters<Session['resolve']>) => {
    await session.start(await session.resolve(...spec));
    const snap = await session.snapshotter.current();
    await session.snapshotter.patchMany(snap.changed.map((f) => f.path));
  };

  describe('between commits', () => {
    beforeAll(() => start({ kind: 'revspec', args: ['main..feat'] }));

    it('serves each side of a changed image under its blob, as its sniffed type, for good', async () => {
      for (const [rev, tag] of [
        ['old', 1],
        ['new', 2],
      ] as const) {
        const res = await image('logo.png', rev, git('rev-parse', `${rev === 'old' ? 'main' : 'feat'}:logo.png`));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/png');
        expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
        expect(await bytes(res)).toEqual(png(tag));
      }
    });

    it("reads a rename's old side from its old path, and an unchanged path under its commit", async () => {
      expect(await bytes(await current('after.png', 'old'))).toEqual(png(3));
      const still = await image('still.png', 'new', git('rev-parse', 'feat'));
      expect(await bytes(still)).toEqual(png(5));
    });

    it("answers 404 for a key that is not the side's, bytes that are no image, and paths outside the snapshot", async () => {
      expect((await image('logo.png', 'old', git('rev-parse', 'feat:logo.png'))).status).toBe(404);
      expect((await image('still.png', 'new', git('rev-parse', 'main'))).status).toBe(404);
      expect((await current('blob.png', 'new')).status).toBe(404);
      expect((await current('ignored.png', 'new')).status).toBe(404);
      expect((await current('before.png', 'new')).status).toBe(404);
      expect((await current('.git/HEAD', 'new')).status).toBe(404);
    });
  });

  describe('against the worktree', () => {
    it("serves a worktree side only while its bytes are the snapshot's", async () => {
      await writeFile(join(dir, 'logo.png'), png(6));
      await start({ kind: 'working' });
      const key = imageKey(await session.snapshotter.current(), 'logo.png', 'new');
      expect(await bytes(await image('logo.png', 'new', key))).toEqual(png(6));
      // No refresh yet: the key still names the old bytes, so the new ones must not be served under it.
      await writeFile(join(dir, 'logo.png'), png(7));
      expect((await image('logo.png', 'new', key)).status).toBe(404);
      git('checkout', '--', 'logo.png');
    });

    it('reads an unchanged path from the commit its key names, not from a worktree that moved on', async () => {
      await start({ kind: 'working' });
      await writeFile(join(dir, 'still.png'), png(8));
      try {
        const res = await image('still.png', 'new', git('rev-parse', 'HEAD'));
        expect(await bytes(res)).toEqual(png(5));
      } finally {
        git('checkout', '--', 'still.png');
      }
    });

    it('keys a worktree old side by its hashed blob', async () => {
      await writeFile(join(dir, 'logo.png'), png(9));
      try {
        await start({ kind: 'revspec', args: ['worktree..HEAD'] });
        expect(imageKey(await session.snapshotter.current(), 'logo.png', 'old')).toBe(git('hash-object', 'logo.png'));
        expect(await bytes(await current('logo.png', 'old'))).toEqual(png(9));
        expect(await bytes(await current('logo.png', 'new'))).toEqual(png(2));
      } finally {
        git('checkout', '--', 'logo.png');
      }
    });
  });
});
