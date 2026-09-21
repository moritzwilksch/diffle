// Build a self-contained HTML report of the committed snapshots that differ between two Git
// revisions, without rerunning any test: `npm run snapshot-report -- --base <rev> [--head <rev>]
// [--out snapshot-report.html]`.
//
// Screenshots get a side-by-side view, an overlay slider and a pixel diff; text snapshots
// (prompts, help text, payloads, accessibility trees) get their unified diff. Each card links the
// test that produced the snapshot, read from the head revision. CI runs this for a pull request
// that touches a `__snapshots__` directory and links the result from a sticky comment.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { basename, dirname, posix } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

interface Change {
  status: 'A' | 'M' | 'D' | 'R';
  before: string | null;
  after: string | null;
}

interface ImageSide {
  png: PNG;
  dataUri: string;
}

interface TestSource {
  file: string;
  line: number;
  source: string;
}

interface Card {
  change: Change;
  /** The path shown, the new one for a rename. */
  path: string;
  kind: 'image' | 'text';
  html: string;
  test: TestSource | null;
}

const SNAPSHOT_PATHSPEC = ':(glob)**/__snapshots__/**';

function usage(message?: string): never {
  if (message) console.error(message);
  console.error('usage: snapshot-report --base <rev> [--head <rev>] [--out <file>]');
  process.exit(2);
}

function parseArgs(argv: string[]) {
  let base: string | undefined;
  let head = 'HEAD';
  let out = 'snapshot-report.html';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === '--base' && value) base = argv[++i];
    else if (arg === '--head' && value) head = argv[++i]!;
    else if (arg === '--out' && value) out = argv[++i]!;
    else usage(`unexpected argument: ${arg}`);
  }
  if (!base) usage();
  return { base, head, out };
}

function git(args: string[], options: { binary?: boolean } = {}): Buffer | string {
  try {
    return execFileSync('git', args, {
      encoding: options.binary ? 'buffer' : 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr?.toString().trim();
    throw new Error(stderr || `git ${args.join(' ')} failed`);
  }
}

const text = (args: string[]) => git(args) as string;

function validateRevision(rev: string): string {
  return text(['rev-parse', '--verify', `${rev}^{commit}`]).trim();
}

/** Snapshot files that differ between the trees; a pure rename renders the same on both sides and is skipped. */
function changedSnapshots(base: string, head: string): Change[] {
  const out = text(['diff', '--name-status', '--find-renames', '-z', base, head, '--', SNAPSHOT_PATHSPEC]);
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
function snapshotCount(rev: string): number {
  const out = text(['ls-tree', '-r', '--name-only', '-z', rev]);
  return out
    .replace(/\0$/, '')
    .split('\0')
    .filter((path) => path.includes('/__snapshots__/')).length;
}

function blob(rev: string, path: string): Buffer {
  return git(['show', `${rev}:${path}`], { binary: true }) as Buffer;
}

function readImage(rev: string, path: string | null): ImageSide | null {
  if (!path) return null;
  const bytes = blob(rev, path);
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

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function textDiffHtml(base: string, head: string, change: Change): string {
  const args = ['diff', '--no-color', '-U3', base, head, '--'];
  if (change.before) args.push(change.before);
  if (change.after && change.after !== change.before) args.push(change.after);
  const diff = text(args);
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

/** The snapshot's name as its test spells it, so the call that produced it can be found in the source. */
function snapshotArg(path: string): string | null {
  const name = basename(path);
  // Playwright: <arg>.<project><ext>; Vitest: the path relative to the test file.
  const shot = /^(.*)\.(light|dark)(\.[a-z]+)$/.exec(name);
  if (shot) return `${shot[1]}${shot[3]}`;
  return name;
}

/** The test function that names this snapshot in `rev`, found by its argument string. */
function findTestSource(rev: string, path: string): TestSource | null {
  const arg = snapshotArg(path);
  if (!arg) return null;
  const snapshotsDir = path.slice(0, path.indexOf('/__snapshots__/') + '/__snapshots__/'.length);
  const testDir = dirname(snapshotsDir);
  // Playwright keeps one directory per spec file; Vitest names the file in the assertion.
  const specName = posix.relative(snapshotsDir, path).split('/')[0]!;
  const candidates = [posix.join(testDir, specName)];
  const listing = text(['ls-tree', '-r', '--name-only', '-z', rev, '--', testDir]);
  for (const file of listing.replace(/\0$/, '').split('\0')) {
    if (/\.(test|spec)\.ts$/.test(file) && !candidates.includes(file)) candidates.push(file);
  }
  for (const file of candidates) {
    let source: string;
    try {
      source = text(['show', `${rev}:${file}`]);
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

function label(path: string): string {
  const parts = path.split('/__snapshots__/');
  return parts.length === 2
    ? `${escapeHtml(parts[1]!)}  <span class="dim">${escapeHtml(parts[0]!)}</span>`
    : escapeHtml(path);
}

function buildCards(base: string, head: string, changes: Change[]): Card[] {
  return changes.map((change, index) => {
    const path = change.after ?? change.before!;
    const kind = path.endsWith('.png') ? 'image' : 'text';
    const html =
      kind === 'image'
        ? imageHtml(readImage(base, change.before), readImage(head, change.after), index)
        : textDiffHtml(base, head, change);
    const test = findTestSource(change.after ? head : base, path);
    return { change, path, kind, html, test };
  });
}

const STATUS_WORD: Record<Change['status'], string> = { A: 'added', M: 'changed', D: 'removed', R: 'renamed' };

function render(cards: Card[], base: string, head: string, unchanged: number): string {
  const counts = cards.reduce<Record<string, number>>(
    (acc, c) => ({ ...acc, [c.change.status]: (acc[c.change.status] ?? 0) + 1 }),
    {},
  );
  const summary = (['A', 'M', 'D', 'R'] as const)
    .filter((s) => counts[s])
    .map((s) => `<span class="badge ${s}">${counts[s]} ${STATUS_WORD[s]}</span>`)
    .join(' ');
  const items = cards
    .map(
      (card, index) => `
<section class="card ${card.change.status}" id="card-${index}">
  <h2><span class="badge ${card.change.status}">${STATUS_WORD[card.change.status]}</span> <code>${label(card.path)}</code>
  ${card.change.status === 'R' ? `<span class="dim">was <code>${escapeHtml(card.change.before!)}</code></span>` : ''}</h2>
  ${card.html}
  ${
    card.test
      ? `<details class="source"><summary>Test source <span class="dim">${escapeHtml(card.test.file)}:${card.test.line}</span></summary><pre>${escapeHtml(card.test.source)}</pre></details>`
      : ''
  }
</section>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Snapshot report</title>
<style>
:root { color-scheme: light dark; --bg: #fff; --fg: #1f2328; --dim: #656d76; --line: #d0d7de; --card: #f6f8fa;
  --add: #1a7f37; --del: #cf222e; --mod: #9a6700; --ren: #8250df; --accent: #0969da; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --fg: #e6edf3; --dim: #8b949e; --line: #30363d; --card: #161b22;
  --add: #3fb950; --del: #f85149; --mod: #d29922; --ren: #a371f7; --accent: #58a6ff; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 1.5rem; font: 14px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
h2 { font-size: .95rem; margin: 0; padding: .6rem .8rem; border-bottom: 1px solid var(--line); display: flex; gap: .6rem; align-items: baseline; flex-wrap: wrap; }
code { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.dim { color: var(--dim); font-weight: normal; font-size: .8rem; }
.summary { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; margin: .5rem 0 1.25rem; color: var(--dim); }
.badge { display: inline-block; padding: 0 .5em; border-radius: 1em; font-size: .75rem; font-weight: 600; color: var(--bg); background: var(--dim); }
.badge.A { background: var(--add); } .badge.D { background: var(--del); } .badge.M { background: var(--mod); } .badge.R { background: var(--ren); }
.card { border: 1px solid var(--line); border-radius: 8px; background: var(--card); margin-bottom: 1.25rem; overflow: hidden; }
.viewbar { display: flex; gap: 1rem; align-items: center; padding: .4rem .8rem; border-bottom: 1px solid var(--line); font-size: .8rem; }
.viewbar .spacer { flex: 1; } .viewbar label { cursor: pointer; }
.stats { color: var(--dim); }
.side { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem; padding: .5rem; }
figure { margin: 0; min-width: 0; } figcaption { font-size: .75rem; color: var(--dim); margin-bottom: .25rem; }
.shot { display: block; width: 100%; height: auto; border: 1px solid var(--line); background: #fff; }
.missing { display: grid; place-items: center; aspect-ratio: 16 / 10; border: 1px dashed var(--line); color: var(--dim); }
.views[data-view="side"] .slider, .views[data-view="side"] .diff { display: none; }
.views[data-view="slider"] .side, .views[data-view="slider"] .diff { display: none; }
.views[data-view="diff"] .side, .views[data-view="diff"] .slider { display: none; }
.slider { padding: .5rem; } .slider input { width: 100%; margin-top: .5rem; }
.stack { position: relative; } .stack .over { position: absolute; inset: 0; }
.stack .handle { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--accent); pointer-events: none; }
.diff { padding: .5rem; }
.textdiff { margin: 0; padding: .75rem .8rem; overflow-x: auto; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.textdiff .add { color: var(--add); } .textdiff .del { color: var(--del); } .textdiff .hunk { color: var(--accent); }
details.source { border-top: 1px solid var(--line); } details.source summary { padding: .4rem .8rem; cursor: pointer; font-size: .8rem; }
details.source pre { margin: 0; padding: .75rem .8rem; overflow-x: auto; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; border-top: 1px solid var(--line); }
.toolbar { display: flex; gap: 1rem; align-items: center; margin-bottom: 1rem; font-size: .85rem; }
</style>
</head>
<body>
<h1>Snapshot report</h1>
<div class="summary">
  <span><code>${escapeHtml(base.slice(0, 12))}</code> → <code>${escapeHtml(head.slice(0, 12))}</code></span>
  ${summary || '<span>no snapshot changed</span>'}
  <span>· ${unchanged} unchanged</span>
</div>
<div class="toolbar">
  <label><input type="checkbox" id="all-diffs"> Show every screenshot as its pixel diff</label>
  <label><input type="checkbox" id="all-sources"> Expand every test source</label>
</div>
${items}
<script>
for (const views of document.querySelectorAll('.views')) {
  for (const radio of views.querySelectorAll('input[type=radio]')) {
    radio.addEventListener('change', () => { views.dataset.view = radio.value; });
  }
  const range = views.querySelector('.slider input[type=range]');
  if (range) range.addEventListener('input', () => {
    const over = views.querySelector('.stack .over');
    const handle = views.querySelector('.stack .handle');
    over.style.clipPath = 'inset(0 ' + (100 - range.value) + '% 0 0)';
    handle.style.left = range.value + '%';
  });
}
document.getElementById('all-diffs').addEventListener('change', (e) => {
  for (const views of document.querySelectorAll('.views')) {
    const target = e.target.checked && views.querySelector('.diff') ? 'diff' : 'side';
    views.dataset.view = target;
    const radio = views.querySelector('input[value=' + target + ']');
    if (radio) radio.checked = true;
  }
});
document.getElementById('all-sources').addEventListener('change', (e) => {
  for (const d of document.querySelectorAll('details.source')) d.open = e.target.checked;
});
</script>
</body>
</html>
`;
}

const { base, head, out } = parseArgs(process.argv.slice(2));
const baseSha = validateRevision(base);
const headSha = validateRevision(head);
const changes = changedSnapshots(baseSha, headSha);
const cards = buildCards(baseSha, headSha, changes);
const unchanged = snapshotCount(headSha) - changes.filter((c) => c.after).length;
writeFileSync(out, render(cards, baseSha, headSha, unchanged));
console.log(`${cards.length} changed snapshot${cards.length === 1 ? '' : 's'}, ${unchanged} unchanged → ${out}`);
