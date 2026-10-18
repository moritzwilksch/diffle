import { execFileSync } from 'node:child_process';
import { basename, dirname, posix } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { type Card, type Change, escapeHtml, render, type TestSource } from './snapshot-report-html.js';

interface ImageSide {
  png: PNG;
  dataUri: string;
}

const SNAPSHOT_PATHSPEC = ':(glob)**/__snapshots__/**';

class ReportRepository {
  constructor(private readonly cwd: string) {}

  read(args: string[]): Buffer {
    try {
      return execFileSync('git', args, {
        cwd: this.cwd,
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const stderr = (error as { stderr?: Buffer | string }).stderr?.toString().trim();
      throw new Error(stderr || `git ${args.join(' ')} failed`);
    }
  }

  text(args: string[]): string {
    return this.read(args).toString('utf8');
  }

  revision(rev: string): string {
    return this.text(['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`]).trim();
  }
}

/** Snapshot files that differ between the trees; a pure rename renders the same on both sides and is skipped. */
function changedSnapshots(repo: ReportRepository, base: string, head: string): Change[] {
  const out = repo.text(['diff', '--name-status', '--find-renames', '-z', base, head, '--', SNAPSHOT_PATHSPEC]);
  const fields = out ? out.replace(/\0$/, '').split('\0') : [];
  const changes: Change[] = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++]!;
    const type = status[0];
    if (type === 'R' || type === 'C') {
      const before = fields[i++]!;
      const after = fields[i++]!;
      if (status !== 'R100') changes.push({ status: 'R', before, after });
    } else if (type === 'A' || type === 'M' || type === 'D') {
      const path = fields[i++]!;
      changes.push({ status: type, before: type === 'A' ? null : path, after: type === 'D' ? null : path });
    } else {
      i++;
    }
  }
  return changes;
}

/** Snapshot files in `rev`. `ls-tree` takes no glob magic, so the tree is filtered here. */
function snapshotCount(repo: ReportRepository, rev: string): number {
  const out = repo.text(['ls-tree', '-r', '--name-only', '-z', rev]);
  return out
    .replace(/\0$/, '')
    .split('\0')
    .filter((path) => path.includes('/__snapshots__/')).length;
}

function readImage(repo: ReportRepository, rev: string, path: string | null): ImageSide | null {
  if (!path) return null;
  const bytes = repo.read(['show', `${rev}:${path}`]);
  return { png: PNG.sync.read(bytes), dataUri: `data:image/png;base64,${bytes.toString('base64')}` };
}

/** `png` on a canvas of `width` x `height`, so two screenshots of different sizes can be compared. */
function padded(png: PNG, width: number, height: number): PNG {
  if (png.width === width && png.height === height) return png;
  const canvas = new PNG({ width, height });
  canvas.data.fill(0);
  for (let y = 0; y < png.height; y++) {
    png.data.copy(canvas.data, y * width * 4, y * png.width * 4, (y + 1) * png.width * 4);
  }
  return canvas;
}

function diffImage(before: ImageSide, after: ImageSide): { dataUri: string; pixels: number; total: number } {
  const width = Math.max(before.png.width, after.png.width);
  const height = Math.max(before.png.height, after.png.height);
  const a = padded(before.png, width, height);
  const b = padded(after.png, width, height);
  const diff = new PNG({ width, height });
  const pixels = pixelmatch(a.data, b.data, diff.data, width, height, { threshold: 0.2, includeAA: true });
  return { dataUri: `data:image/png;base64,${PNG.sync.write(diff).toString('base64')}`, pixels, total: width * height };
}

function textDiffHtml(repo: ReportRepository, base: string, head: string, change: Change): string {
  const args = ['diff', '--no-color', '-U3', base, head, '--'];
  if (change.before) args.push(change.before);
  if (change.after && change.after !== change.before) args.push(change.after);
  const diff = repo.text(args);
  const body = diff
    .split('\n')
    .filter((line) => !/^(diff --git|index |--- |\+\+\+ |similarity index|rename (from|to))/.test(line))
    .map((line) => {
      const cls = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : '';
      return `<span class="${cls}">${escapeHtml(line)}</span>`;
    })
    .join('\n');
  return `<pre class="textdiff">${body}</pre>`;
}

function imageHtml(before: ImageSide | null, after: ImageSide | null, index: number): string {
  const missing = (label: string) => `<div class="missing">${label}</div>`;
  const img = (side: ImageSide | null, label: string, cls: string) =>
    side ? `<img class="${cls}" src="${side.dataUri}" alt="${label}">` : missing(label);
  const diff = before && after ? diffImage(before, after) : null;
  const stats = diff
    ? `${diff.pixels.toLocaleString()} of ${diff.total.toLocaleString()} pixels differ (${((100 * diff.pixels) / diff.total).toFixed(2)}%)`
    : before
      ? 'removed'
      : 'added';
  return `
<div class="views" data-view="side">
  <div class="viewbar">
    <span class="stats">${stats}</span>
    <span class="spacer"></span>
    <label><input type="radio" name="view-${index}" value="side" checked> Side by side</label>
    ${diff ? `<label><input type="radio" name="view-${index}" value="slider"> Slider</label>` : ''}
    ${diff ? `<label><input type="radio" name="view-${index}" value="diff"> Diff</label>` : ''}
  </div>
  <div class="side">
    <figure><figcaption>base</figcaption>${img(before, 'Not present in base', 'shot')}</figure>
    <figure><figcaption>head</figcaption>${img(after, 'Not present in head', 'shot')}</figure>
  </div>
  ${
    diff
      ? `<div class="slider">
    <div class="stack">
      <img class="shot" src="${before!.dataUri}" alt="base">
      <img class="shot over" src="${after!.dataUri}" alt="head" style="clip-path: inset(0 50% 0 0)">
      <div class="handle" style="left: 50%"></div>
    </div>
    <input type="range" min="0" max="100" value="50" aria-label="Reveal head over base">
  </div>
  <div class="diff"><img class="shot" src="${diff.dataUri}" alt="pixel differences"></div>`
      : ''
  }
</div>`;
}

/** The test function that names this snapshot in `rev`, found by its argument string. */
function findTestSource(repo: ReportRepository, rev: string, path: string): TestSource | null {
  // Playwright names the file after its argument; Vitest names it in the assertion.
  const arg = basename(path);
  const snapshotsDir = path.slice(0, path.indexOf('/__snapshots__/') + '/__snapshots__/'.length);
  const testDir = dirname(snapshotsDir);
  // Playwright keeps one directory per spec file; Vitest names the file in the assertion.
  const specName = posix.relative(snapshotsDir, path).split('/')[0]!;
  const candidates = [posix.join(testDir, specName)];
  const listing = repo.text(['ls-tree', '-r', '--name-only', '-z', rev, '--', testDir]);
  for (const file of listing.replace(/\0$/, '').split('\0')) {
    if (/\.(test|spec)\.ts$/.test(file) && !candidates.includes(file)) candidates.push(file);
  }
  for (const file of candidates) {
    let source: string;
    try {
      source = repo.text(['show', `${rev}:${file}`]);
    } catch {
      continue;
    }
    const lines = source.split('\n');
    const at = lines.findIndex((line) => line.includes(`'${arg}'`) || line.includes(`"${arg}"`));
    if (at === -1) continue;
    let start = at;
    while (start > 0 && !/^\s*(test|it)(\.\w+)*\(/.test(lines[start]!)) start--;
    let end = at;
    while (end < lines.length - 1 && !/^\s{0,2}\}\);\s*$/.test(lines[end]!)) end++;
    return { file, line: start + 1, source: lines.slice(start, end + 1).join('\n') };
  }
  return null;
}

function buildCards(repo: ReportRepository, base: string, head: string, changes: Change[]): Card[] {
  return changes.map((change, index) => {
    const path = change.after ?? change.before!;
    const kind = path.endsWith('.png') ? 'image' : 'text';
    const html =
      kind === 'image'
        ? imageHtml(readImage(repo, base, change.before), readImage(repo, head, change.after), index)
        : textDiffHtml(repo, base, head, change);
    const test = findTestSource(repo, change.after ? head : base, path);
    return { change, path, kind, html, test };
  });
}

export interface SnapshotReportOptions {
  cwd: string;
  base: string;
  head?: string;
}

/** Compare committed snapshot trees and return a self-contained HTML report without writing files. */
export function generateSnapshotReport({ cwd, base, head = 'HEAD' }: SnapshotReportOptions) {
  const repo = new ReportRepository(cwd);
  const baseSha = repo.revision(base);
  const headSha = repo.revision(head);
  const changes = changedSnapshots(repo, baseSha, headSha);
  const cards = buildCards(repo, baseSha, headSha, changes);
  const unchanged = snapshotCount(repo, headSha) - changes.filter((c) => c.after).length;
  return { html: render(cards, baseSha, headSha, unchanged), changed: cards.length, unchanged };
}
