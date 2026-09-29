import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmTmp } from '../tmp.js';
import { GitRepo } from '../../src/server/git/GitRepo.js';
import { imageType } from '../../src/server/image.js';
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
    });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'diffle-image-'));
    git('init', '-q', '-b', 'main');
    await writeFile(join(dir, 'logo.png'), png(1));
    await writeFile(join(dir, 'before.png'), png(3));
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
    await session.start({ kind: 'revspec', args: ['main..feat'] });
  });
  afterAll(async () => {
    await session.close();
    await rmTmp(dir);
  });

  const image = (path: string, rev: string) =>
    app.request(`/api/image?${new URLSearchParams({ path, rev, v: 'k' }).toString()}`);

  it('serves each side of a changed image as its sniffed type', async () => {
    for (const [rev, tag] of [
      ['old', 1],
      ['new', 2],
    ] as const) {
      const res = await image('logo.png', rev);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
      expect(Buffer.from(await res.arrayBuffer())).toEqual(png(tag));
    }
  });

  it("reads a rename's old side from its old path", async () => {
    const res = await image('after.png', 'old');
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(png(3));
  });

  it('answers 404 for bytes that are no image and for paths outside the snapshot', async () => {
    expect((await image('blob.png', 'new')).status).toBe(404);
    expect((await image('ignored.png', 'new')).status).toBe(404);
    expect((await image('before.png', 'new')).status).toBe(404);
    expect((await image('.git/HEAD', 'new')).status).toBe(404);
  });
});
