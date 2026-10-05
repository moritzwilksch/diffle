import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { expect, it } from 'vitest';
import { generateSnapshotReport } from '../../scripts/lib/snapshot-report.js';
import { rmTmp } from '../tmp.js';

/** An empty repository and a `git` runner inside it. */
async function repo() {
  const dir = await mkdtemp(join(tmpdir(), 'diffle-report-module-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '-q', '--template=');
  git('config', 'user.name', 'Report test');
  git('config', 'user.email', 'report@example.com');
  return { dir, git };
}

it('reports additions, deletions, edited renames and differently sized images from a real repository', async () => {
  const { dir, git } = await repo();
  const png = (width: number, height: number, red: number) => {
    const image = new PNG({ width, height });
    for (let i = 0; i < image.data.length; i += 4) {
      image.data[i] = red;
      image.data[i + 3] = 255;
    }
    return PNG.sync.write(image);
  };
  try {
    const snapshots = join(dir, 'test/__snapshots__');
    await mkdir(snapshots, { recursive: true });
    const original = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n';
    await writeFile(join(snapshots, 'old.txt'), original);
    await writeFile(join(snapshots, 'pure.txt'), 'unchanged contents\n');
    await writeFile(join(snapshots, 'deleted.txt'), 'removed contents\n');
    await writeFile(join(snapshots, 'sample.png'), png(2, 2, 0));
    await writeFile(
      join(dir, 'test/demo.spec.ts'),
      "test('image', async () => {\n  await expect(page).toHaveScreenshot('sample.png');\n});\n",
    );
    git('add', '.');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    await rename(join(snapshots, 'old.txt'), join(snapshots, 'renamed.txt'));
    await writeFile(join(snapshots, 'renamed.txt'), original.replace('line 10', 'edited line 10'));
    await rename(join(snapshots, 'pure.txt'), join(snapshots, 'pure-renamed.txt'));
    await rm(join(snapshots, 'deleted.txt'));
    await writeFile(join(snapshots, 'added.txt'), 'added contents\n');
    await writeFile(join(snapshots, 'sample.png'), png(4, 3, 255));
    git('add', '-A');
    git('commit', '-qm', 'head');

    const report = generateSnapshotReport({ cwd: dir, base });
    expect(report.changed).toBe(4);
    expect(report.unchanged).toBe(1);
    expect(report.html).toContain('<span class="badge R">renamed</span>');
    expect(report.html).toContain('was <code>test/__snapshots__/old.txt</code>');
    expect(report.html).toContain('<span class="del">-removed contents</span>');
    expect(report.html).toContain('<span class="add">+added contents</span>');
    expect(report.html).not.toContain('pure-renamed.txt');
    expect(report.html).toContain('test/demo.spec.ts:1');
    const diff = /src="data:image\/png;base64,([^"]+)" alt="pixel differences"/.exec(report.html)?.[1];
    expect(diff).toBeDefined();
    const image = PNG.sync.read(Buffer.from(diff!, 'base64'));
    expect({ width: image.width, height: image.height }).toEqual({ width: 4, height: 3 });
    expect(generateSnapshotReport({ cwd: dir, base: 'HEAD' })).toMatchObject({ changed: 0, unchanged: 4 });
  } finally {
    await rmTmp(dir);
  }
});

// Windows cannot represent the angle brackets used by an HTML injection in filenames.
it.skipIf(process.platform === 'win32')('escapes snapshot filenames, directories, and contents', async () => {
  const { dir, git } = await repo();
  try {
    git('commit', '--allow-empty', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    const snapshots = join(dir, 'test<img src=x onerror=alert(1)>', '__snapshots__');
    await mkdir(snapshots, { recursive: true });
    await writeFile(join(snapshots, '<img src=x onerror=alert(2)> & notes.txt'), '<script>alert(3)</script>\n');
    git('add', '.');
    git('commit', '-qm', 'add snapshot');
    const { html } = generateSnapshotReport({ cwd: dir, base });
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt; &amp; notes.txt');
    expect(html).toContain('<span class="dim">test&lt;img src=x onerror=alert(1)&gt;</span>');
    expect(html).toContain('&lt;script&gt;alert(3)&lt;/script&gt;');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert(3)');
  } finally {
    await rmTmp(dir);
  }
});
