// Renders the snapshot report page from cards that `snapshot-report.ts` collected from Git.

export interface Change {
  status: 'A' | 'M' | 'D' | 'R';
  before: string | null;
  after: string | null;
}

export interface TestSource {
  file: string;
  line: number;
  source: string;
}

export interface Card {
  change: Change;
  /** The path shown, the new one for a rename. */
  path: string;
  kind: 'image' | 'text';
  html: string;
  test: TestSource | null;
}

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function label(path: string): string {
  const parts = path.split('/__snapshots__/');
  return parts.length === 2
    ? `${escapeHtml(parts[1]!)}  <span class="dim">${escapeHtml(parts[0]!)}</span>`
    : escapeHtml(path);
}

const STATUS_WORD: Record<Change['status'], string> = { A: 'added', M: 'changed', D: 'removed', R: 'renamed' };

export function render(cards: Card[], base: string, head: string, unchanged: number): string {
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
