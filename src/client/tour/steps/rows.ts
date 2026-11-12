import type { Side } from '@/shared/side.js';

/**
 * Rows of an excerpt a stepped block lights: which rows each note lights, where the taken note's
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

/** A row's text, as the diff renders it inside its shadow root. */
export function lineSelector(spot: RowSpot): string {
  return `[data-line="${spot.lineNumber}"][data-line-type="${spot.type}"]`;
}

/** A row's line number, as the diff renders it inside its shadow root. */
export function gutterSelector(spot: RowSpot): string {
  return `[data-column-number="${spot.lineNumber}"][data-line-type="${spot.type}"]`;
}

/** The width of the lane left of a walk's line numbers where its notes' badges sit. */
export const MARK_LANE = 24;

/**
 * The stylesheet for a walk at `active` (null at rest): a lane left of the line numbers for the
 * notes' badges, and while a note is active, its rows lit and every other row dimmed.
 */
export function walkCss(
  rows: readonly WalkRow[],
  side: Side,
  notes: readonly NoteSpan[],
  active: number | null,
): string {
  const lane = `[data-column-number] { border-left: ${MARK_LANE}px solid transparent; }`;
  return active == null ? lane : `${lane}\n${litCss(rows, side, notes[active]!)}`;
}

/** The rows of `span` lit and every other row dimmed. */
export function litCss(rows: readonly WalkRow[], side: Side, span: NoteSpan): string {
  const lit = noteRows(rows, side, span);
  if (!lit) return '';
  const shown = rows.slice(lit[0], lit[1] + 1).map(rowSpot);
  const lines = shown.map(lineSelector).join(', ');
  const gutters = shown.map(gutterSelector).join(', ');
  return [
    `[data-line], [data-column-number] { opacity: 0.38; transition: opacity 120ms; }`,
    `:is(${lines}, ${gutters}) { opacity: 1; }`,
    `:is(${lines})[data-line-type='context'] { background-color: ${LIT_FACE}; }`,
    `:is(${gutters}) { box-shadow: inset 2px 0 0 var(--accent); }`,
  ].join('\n');
}

const LIT_FACE = 'color-mix(in srgb, var(--accent) 8%, transparent)';
