import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { rmTmp } from '../tmp.js';

const TSX = join(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
const SCRIPT = join(process.cwd(), 'scripts/snapshot-report.ts');

// Windows cannot represent the angle brackets used by an HTML injection in filenames.
it.skipIf(process.platform === 'win32')('escapes snapshot filenames and directories in the HTML report', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'diffle-report-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  try {
    git('init', '-q', '--template=');
    git('config', 'user.name', 'Snapshot test');
    git('config', 'user.email', 'snapshot@example.com');
    git('commit', '--allow-empty', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    const snapshots = join(dir, 'test<img src=x onerror=alert(1)>', '__snapshots__');
    await mkdir(snapshots, { recursive: true });
    await writeFile(join(snapshots, '<img src=x onerror=alert(2)> & notes.txt'), '<script>alert(3)</script>\n');
    git('add', '.');
    git('commit', '-qm', 'add snapshot');
    const out = join(dir, 'report.html');
    execFileSync(process.execPath, [TSX, SCRIPT, '--base', base, '--out', out], { cwd: dir });
    const html = await readFile(out, 'utf8');
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt; &amp; notes.txt');
    expect(html).toContain('<span class="dim">test&lt;img src=x onerror=alert(1)&gt;</span>');
    expect(html).toContain('&lt;script&gt;alert(3)&lt;/script&gt;');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert(3)');
  } finally {
    await rmTmp(dir);
  }
});
