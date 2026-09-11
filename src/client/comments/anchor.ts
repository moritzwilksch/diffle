import type { CodeViewLineSelection, FileDiffMetadata } from '@pierre/diffs';
import type { LineAnchor, Side } from '../../shared/protocol.js';

export interface ResolvedRange {
  side: Side;
  startLine: number;
  endLine: number;
}

/**
 * Selections on the deletions column of context lines (unified view, or
 * clicking the left gutter in split view) are really about lines that still
 * exist. Map those to the new side so the quote and the export point at
 * current code. Real deletions stay on the old side.
 */
export function resolveRange(sel: CodeViewLineSelection, fileDiff: FileDiffMetadata | undefined): ResolvedRange {
  const side = sideOf(sel);
  const { startLine, endLine } = lineBounds(sel);
  if (side === 'new' || !fileDiff) return { side, startLine, endLine };
  const mapped: number[] = [];
  for (let old = startLine; old <= endLine; old++) {
    const n = contextOldToNew(fileDiff, old);
    if (n == null) return { side: 'old', startLine, endLine };
    mapped.push(n);
  }
  return { side: 'new', startLine: mapped[0]!, endLine: mapped[mapped.length - 1]! };
}

/** New-side line for an old-side context line, or null if the line was deleted. */
function contextOldToNew(fileDiff: FileDiffMetadata, oldLine: number): number | null {
  for (const h of fileDiff.hunks) {
    let o = h.deletionStart;
    let n = h.additionStart;
    for (const block of h.hunkContent) {
      if (block.type === 'context') {
        if (oldLine >= o && oldLine < o + block.lines) return n + (oldLine - o);
        o += block.lines;
        n += block.lines;
      } else {
        if (oldLine >= o && oldLine < o + block.deletions) return null;
        o += block.deletions;
        n += block.additions;
      }
    }
  }
  // Outside every hunk: unchanged region, same line number on both sides only if
  // no net shift; be conservative and keep the old side.
  return null;
}

export function sideOf(sel: CodeViewLineSelection): Side {
  const s = sel.range.endSide ?? sel.range.side;
  return s === 'deletions' ? 'old' : 'new';
}

export function lineBounds(sel: CodeViewLineSelection): { startLine: number; endLine: number } {
  const a = sel.range.start;
  const b = sel.range.end;
  return { startLine: Math.min(a, b), endLine: Math.max(a, b) };
}

export function quoteLines(contents: string, startLine: number, endLine: number): string {
  const lines = contents.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(Math.max(0, startLine - 1), Math.max(0, endLine)).join('\n');
}

/** Builds the durable anchor for a resolved range, quoting from that side's contents. */
export function anchorFromRange(path: string, range: ResolvedRange, contents: string): LineAnchor {
  return { kind: 'line', path, ...range, quoted: quoteLines(contents, range.startLine, range.endLine) };
}
