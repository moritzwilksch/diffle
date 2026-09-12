import type { CommentAnchor, CommentThread, LineAnchor } from '../../shared/protocol.js';

function splitLines(contents: string): string[] {
  const lines = contents.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Text of [startLine, endLine] (1-based, inclusive) joined with '\n'. */
export function quoteLines(contents: string, startLine: number, endLine: number): string {
  const lines = splitLines(contents);
  return lines.slice(Math.max(0, startLine - 1), Math.max(0, endLine)).join('\n');
}

/**
 * Find `anchor.quoted` in `contents`, preferring the match nearest
 * `anchor.startLine`. Returns a moved anchor, or null when the text is gone.
 */
export function relocate(anchor: LineAnchor, contents: string): LineAnchor | null {
  const lines = splitLines(contents);
  const quoted = splitLines(anchor.quoted);
  if (quoted.length === 0) return anchor;
  const span = quoted.length;
  let best: number | null = null;
  let bestDist = Infinity;
  outer: for (let i = 0; i + span <= lines.length; i++) {
    for (let j = 0; j < span; j++) {
      if (lines[i + j] !== quoted[j]) continue outer;
    }
    const start = i + 1;
    const dist = Math.abs(start - anchor.startLine);
    if (dist < bestDist) {
      best = start;
      bestDist = dist;
      if (dist === 0) break;
    }
  }
  if (best == null) return null;
  return { ...anchor, startLine: best, endLine: best + span - 1 };
}

/**
 * Text of a 1-based inclusive range, or null when the range does not fit the
 * contents: the server refuses to quote lines that do not exist.
 */
export function quoteRange(contents: string, startLine: number, endLine: number): string | null {
  const lines = splitLines(contents);
  if (startLine < 1 || endLine < startLine || endLine > lines.length) return null;
  return lines.slice(startLine - 1, endLine).join('\n');
}

/** The line a thread sorts under: a file thread comes before every line of its file. */
export function anchorLine(anchor: CommentAnchor): number {
  return anchor.kind === 'line' ? anchor.startLine : 0;
}

/** Review order: by path, then line (file threads first), then when the thread was opened. */
export function compareThreads(a: CommentThread, b: CommentThread): number {
  if (a.anchor.path !== b.anchor.path) return a.anchor.path < b.anchor.path ? -1 : 1;
  const line = anchorLine(a.anchor) - anchorLine(b.anchor);
  if (line !== 0) return line;
  return (a.messages[0]?.createdAt ?? 0) - (b.messages[0]?.createdAt ?? 0);
}
