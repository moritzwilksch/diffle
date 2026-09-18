import type { Side } from '../../shared/protocol.js';

/** 1-based inclusive line range. */
export type LineRange = [start: number, end: number];

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Line ranges of one side that a unified patch shows: each hunk's span, context included.
 * With `context`, only the lines within that many of a change, as a diff generated with
 * that much context would show them — narrowing only, so a patch with less context keeps
 * its hunks. A binary or empty patch shows nothing.
 */
export function shownRanges(patch: string, side: Side, context = Infinity): LineRange[] {
  const ranges: LineRange[] = [];
  const lines = patch.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = HUNK_HEADER.exec(lines[i]!);
    if (!m) continue;
    const counts = { old: m[2] == null ? 1 : Number(m[2]), new: m[4] == null ? 1 : Number(m[4]) };
    const at = { old: Number(m[1]), new: Number(m[3]) };
    if (counts[side] === 0) continue;
    const hunk: LineRange = [at[side], at[side] + counts[side] - 1];
    // A change run's context on `side`: the run's own lines, or the gap where the other side changed.
    let run: number | null = null;
    const flush = () => {
      if (run == null) return;
      ranges.push([Math.max(hunk[0], run - context), Math.min(hunk[1], at[side] - 1 + context)]);
      run = null;
    };
    while ((counts.old > 0 || counts.new > 0) && ++i < lines.length) {
      const c = lines[i]![0];
      if (c === ' ') {
        flush();
        at.old++;
        at.new++;
        counts.old--;
        counts.new--;
      } else if (c === '-' || c === '+') {
        run ??= at[side];
        const changed = c === '-' ? 'old' : 'new';
        at[changed]++;
        counts[changed]--;
      }
    }
    flush();
  }
  return merge(ranges);
}

/** Overlapping or adjacent ranges as one; the input is in line order. */
function merge(ranges: LineRange[]): LineRange[] {
  const out: LineRange[] = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** True when every line of [startLine, endLine] lies inside one shown range. */
export function isShown(ranges: LineRange[], startLine: number, endLine: number): boolean {
  return ranges.some(([s, e]) => startLine >= s && endLine <= e);
}
