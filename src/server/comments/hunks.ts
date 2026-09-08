import type { Side } from '../../shared/protocol.js';

/** 1-based inclusive line range. */
export type LineRange = [start: number, end: number];

/**
 * Line ranges of one side that a unified patch shows: each hunk's span,
 * context included. A binary or empty patch shows nothing.
 */
export function shownRanges(patch: string, side: Side): LineRange[] {
  const ranges: LineRange[] = [];
  const re = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  for (let m = re.exec(patch); m != null; m = re.exec(patch)) {
    const [start, count] = side === 'old' ? [m[1], m[2]] : [m[3], m[4]];
    const n = count == null ? 1 : Number(count);
    if (n === 0) continue;
    const s = Number(start);
    ranges.push([s, s + n - 1]);
  }
  return ranges;
}

/** True when every line of [startLine, endLine] lies inside one shown range. */
export function isShown(ranges: LineRange[], startLine: number, endLine: number): boolean {
  return ranges.some(([s, e]) => startLine >= s && endLine <= e);
}
