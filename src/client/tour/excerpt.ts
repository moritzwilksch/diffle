import type { LineRange } from './document.js';

interface Row {
  kind: ' ' | '-' | '+';
  old: number | null;
  new: number | null;
  text: string;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * The lines `range` names as a patch of one hunk, numbered as in the file: the review's changes
 * among them, and the deletions or additions that sit right at their edges. `text` is the file on
 * the range's side, `patch` its patch in the review (empty when it did not change). Null when the
 * range runs past the file: its lines are gone.
 */
export function excerpt(range: LineRange, text: string, patch: string): string | null {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (range.end > lines.length) return null;
  const rows = fileRows(range.side, lines, patch);
  const at = (r: Row) => (range.side === 'new' ? r.new : r.old);
  const other = range.side === 'new' ? '-' : '+';
  let first = rows.findIndex((r) => at(r) === range.start);
  let last = rows.findLastIndex((r) => at(r) === range.end);
  if (first < 0 || last < 0) return null;
  while (first > 0 && rows[first - 1]!.kind === other) first--;
  while (last + 1 < rows.length && rows[last + 1]!.kind === other) last++;
  const shown = rows.slice(first, last + 1);
  // A side with no line here starts after the line before, as unified diffs count it.
  const start = (side: 'old' | 'new') =>
    shown.find((r) => r[side] != null)?.[side] ?? rows.slice(0, first).findLast((r) => r[side] != null)?.[side] ?? 0;
  const count = (side: 'old' | 'new') => shown.filter((r) => r[side] != null).length;
  const header = `@@ -${start('old')},${count('old')} +${start('new')},${count('new')} @@`;
  const body = shown.map((r) => `${r.kind}${r.text}`).join('\n');
  return `diff --git a/${range.path} b/${range.path}\n--- a/${range.path}\n+++ b/${range.path}\n${header}\n${body}\n`;
}

/** Every line of the file in diff order: its unchanged lines from `lines`, its changes from the patch. */
function fileRows(side: 'old' | 'new', lines: string[], patch: string): Row[] {
  const rows: Row[] = [];
  let [old, nw] = [1, 1];
  const unchangedUntil = (oldLine: number) => {
    for (; old < oldLine; old++, nw++)
      rows.push({ kind: ' ', old, new: nw, text: lines[(side === 'new' ? nw : old) - 1] ?? '' });
  };
  let inHunk = false;
  for (const line of patch.split('\n')) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      const [oldStart, oldCount] = [Number(hunk[1]), hunk[2] == null ? 1 : Number(hunk[2])];
      // A hunk that removes nothing names the old line before it.
      unchangedUntil(oldCount === 0 ? oldStart + 1 : oldStart);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    const [kind, text] = [line[0], line.slice(1)];
    if (kind === ' ') rows.push({ kind, old: old++, new: nw++, text });
    else if (kind === '-') rows.push({ kind, old: old++, new: null, text });
    else if (kind === '+') rows.push({ kind, old: null, new: nw++, text });
    else if (kind !== '\\') inHunk = false;
  }
  const end = side === 'new' ? lines.length - nw + old + 1 : lines.length + 1;
  unchangedUntil(end);
  return rows;
}
