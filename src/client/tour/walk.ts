import type { Side } from '@/shared/protocol.js';

/**
 * A `diffle-walk` on the page: which rows of its excerpt each note lights, where the active note's
 * text hangs, and the stylesheet that marks and dims the rows inside the diff's shadow root. Rows
 * are named as `@pierre/diffs` renders a unified diff: a deletion by its old number, any other row
 * by its new one, each with its `data-line-type`.
 */

/** A row of an excerpt, numbered on each side it has. */
export interface WalkRow {
  kind: ' ' | '-' | '+';
  old: number | null;
  new: number | null;
}

/** A note's lines, on the walk's side. */
export interface NoteSpan {
  start: number;
  end: number;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** The rows of `patch`, one hunk as `excerpt` cuts it. */
export function excerptRows(patch: string): WalkRow[] {
  const rows: WalkRow[] = [];
  let [old, nw] = [0, 0];
  let inHunk = false;
  for (const line of patch.split('\n')) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      [old, nw, inHunk] = [Number(hunk[1]), Number(hunk[2]), true];
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith(' ')) rows.push({ kind: ' ', old: old++, new: nw++ });
    else if (line.startsWith('-')) rows.push({ kind: '-', old: old++, new: null });
    else if (line.startsWith('+')) rows.push({ kind: '+', old: null, new: nw++ });
  }
  return rows;
}

/**
 * The first and last row `note` lights: from the row of its first line to the row of its last,
 * with the other side's rows between them. Null when the excerpt does not hold them.
 */
export function noteRows(rows: readonly WalkRow[], side: Side, note: NoteSpan): [number, number] | null {
  const at = (r: WalkRow) => (side === 'new' ? r.new : r.old);
  const first = rows.findIndex((r) => at(r) === note.start);
  const last = rows.findLastIndex((r) => at(r) === note.end);
  return first < 0 || last < first ? null : [first, last];
}

/** Where a row's text and gutter number sit, as the diff renders it. */
export interface RowSpot {
  /** `deletions` for a removed row, `additions` for any other, as the diff's annotations name sides. */
  side: 'deletions' | 'additions';
  lineNumber: number;
  /** The diff's `data-line-type`. */
  type: 'change-deletion' | 'change-addition' | 'context';
}

export function rowSpot(row: WalkRow): RowSpot {
  if (row.kind === '-') return { side: 'deletions', lineNumber: row.old!, type: 'change-deletion' };
  return { side: 'additions', lineNumber: row.new!, type: row.kind === '+' ? 'change-addition' : 'context' };
}

/** The note whose marker sits on the gutter at `spot`: the note that starts on that row. */
export function noteAt(
  rows: readonly WalkRow[],
  side: Side,
  notes: readonly NoteSpan[],
  spot: Pick<RowSpot, 'side' | 'lineNumber'>,
): number | null {
  const found = notes.findIndex((note) => {
    const lit = noteRows(rows, side, note);
    const first = lit && rowSpot(rows[lit[0]]!);
    return first?.side === spot.side && first.lineNumber === spot.lineNumber;
  });
  return found < 0 ? null : found;
}

/** A row's text, as the diff renders it inside its shadow root. */
export function lineSelector(spot: RowSpot): string {
  return `[data-line="${spot.lineNumber}"][data-line-type="${spot.type}"]`;
}

function gutterSelector(spot: RowSpot): string {
  return `[data-column-number="${spot.lineNumber}"][data-line-type="${spot.type}"]`;
}

/**
 * The stylesheet for a walk at `active` (null at rest): a numbered marker on the gutter of each
 * note's first row, and while a note is active, its rows lit and every other row dimmed.
 */
export function walkCss(
  rows: readonly WalkRow[],
  side: Side,
  notes: readonly NoteSpan[],
  active: number | null,
): string {
  const rules: string[] = [];
  notes.forEach((note, i) => {
    const lit = noteRows(rows, side, note);
    if (!lit) return;
    const gutter = gutterSelector(rowSpot(rows[lit[0]]!));
    const state = i === active ? 'active' : 'idle';
    rules.push(`${gutter} { --walk-marker: '${i + 1}'; position: relative; cursor: pointer; }`);
    rules.push(`${gutter}::before { ${MARKER} ${state === 'active' ? MARKER_ACTIVE : MARKER_IDLE} }`);
  });
  const lit = active == null ? null : noteRows(rows, side, notes[active]!);
  if (lit) {
    const shown = rows.slice(lit[0], lit[1] + 1).map(rowSpot);
    const lines = shown.map(lineSelector).join(', ');
    const gutters = shown.map(gutterSelector).join(', ');
    rules.push(`[data-line], [data-column-number] { opacity: 0.38; transition: opacity 120ms; }`);
    rules.push(`:is(${lines}, ${gutters}) { opacity: 1; }`);
    rules.push(`:is(${lines})[data-line-type='context'] { background-color: ${LIT_FACE}; }`);
    rules.push(`:is(${gutters}) { box-shadow: inset 2px 0 0 var(--accent); }`);
  }
  return rules.join('\n');
}

const MARKER = `content: var(--walk-marker); position: absolute; left: 3px; top: 50%; translate: 0 -50%;
  display: grid; place-items: center; width: 1.05em; height: 1.05em; border-radius: 999px;
  font: 600 0.6875rem/1 var(--sans); opacity: 1;`;
const MARKER_IDLE = `color: var(--accent); background: var(--bg-card); box-shadow: inset 0 0 0 1px var(--accent);`;
const MARKER_ACTIVE = `color: var(--accent-fg); background: var(--accent);`;
const LIT_FACE = 'color-mix(in srgb, var(--accent) 8%, transparent)';

/** Each walk on the page with what steps it: by one note on, or back. */
export const walks = new Map<Element, (by: 1 | -1) => void>();

/**
 * The walk the reader is at: of those in `view`, the one nearest `gaze` (a client y), inside it
 * when one holds that line. Null when none is in view.
 */
export function walkAt(view: DOMRect, gaze: number): ((by: 1 | -1) => void) | null {
  let best: { step: (by: 1 | -1) => void; distance: number } | null = null;
  for (const [el, step] of walks) {
    const box = el.getBoundingClientRect();
    if (box.bottom <= view.top || box.top >= view.bottom) continue;
    const distance = gaze < box.top ? box.top - gaze : gaze > box.bottom ? gaze - box.bottom : 0;
    if (!best || distance < best.distance) best = { step, distance };
  }
  return best?.step ?? null;
}

/** The tour's scrolling page, which a walk scrolls to keep its lit lines in view. */
export const walkPage: { current: HTMLElement | null } = { current: null };

/** Room kept between lit lines and the page's edge when stepping scrolls. */
const EDGE = 16;

/** Scrolls the page just enough to show `top` to `bottom` (client y); not at all when they show. */
export function reveal(top: number, bottom: number): void {
  const page = walkPage.current;
  if (!page) return;
  const view = page.getBoundingClientRect();
  const above = top - (view.top + EDGE);
  const below = bottom - (view.bottom - EDGE);
  // Too tall to fit: its top shows first.
  const by = above < 0 ? above : below > 0 ? Math.min(below, above) : 0;
  if (by !== 0) page.scrollBy({ top: by, behavior: 'smooth' });
}
