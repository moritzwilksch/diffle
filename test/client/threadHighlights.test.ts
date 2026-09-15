// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { CommentAnchor, CommentThread, LineAnchor } from '../../src/shared/protocol.js';
import { THREAD_LINE_ATTR, markThreadRows, tintedAnchors } from '../../src/client/review/threadHighlights.js';

const anchor = (side: 'old' | 'new', startLine: number, endLine: number): LineAnchor => ({
  kind: 'line',
  path: 'a.ts',
  side,
  startLine,
  endLine,
  quoted: '',
});

/** A viewer column: gutter and content cells paired by index, the shape the library renders. */
function column(rows: { line?: number; type?: string }[], side?: 'deletions' | 'additions'): HTMLElement {
  const code = document.createElement('code');
  if (side) code.setAttribute(`data-${side}`, '');
  const gutter = document.createElement('div');
  const content = document.createElement('div');
  for (const r of rows) {
    const g = document.createElement('div');
    const c = document.createElement('div');
    if (r.line != null) {
      g.dataset.columnNumber = String(r.line);
      c.dataset.line = String(r.line);
    } else {
      g.dataset.gutterBuffer = 'annotation';
      c.dataset.lineAnnotation = '';
    }
    if (r.type) c.dataset.lineType = r.type;
    gutter.append(g);
    content.append(c);
  }
  code.append(gutter, content);
  return code;
}

const marked = (root: ParentNode): string[] =>
  [...root.querySelectorAll(`[${THREAD_LINE_ATTR}]`)].map((el) => {
    const e = el as HTMLElement;
    const col = e.closest('code')!.hasAttribute('data-deletions') ? 'old' : 'new';
    return `${col}:${e.dataset.line ?? e.dataset.columnNumber}${e.dataset.line != null ? '' : '#'}`;
  });

describe('markThreadRows', () => {
  it('tints content and gutter cells of every line in a unified range, on the anchored side only', () => {
    const pre = document.createElement('pre');
    pre.append(
      column([
        { line: 1, type: 'context' },
        { line: 2, type: 'change-deletion' },
        { line: 2, type: 'change-addition' },
        { line: 3, type: 'change-addition' },
        {},
        { line: 4, type: 'context' },
      ]),
    );
    markThreadRows(pre, [anchor('new', 2, 3)]);
    expect(marked(pre)).toEqual(['new:2#', 'new:3#', 'new:2', 'new:3']);
    // The card row under the range stays as it is.
    expect(pre.querySelector('[data-line-annotation]')!.hasAttribute(THREAD_LINE_ATTR)).toBe(false);
  });
  it('follows the deleted side in a split diff', () => {
    const pre = document.createElement('pre');
    pre.append(column([{ line: 5 }, { line: 6 }], 'deletions'), column([{ line: 5 }, { line: 6 }], 'additions'));
    markThreadRows(pre, [anchor('old', 6, 6), anchor('new', 5, 5)]);
    expect(marked(pre)).toEqual(['old:6#', 'old:6', 'new:5#', 'new:5']);
  });
  it('leaves a resolved thread untinted while resolved cards are hidden', () => {
    const thread = (id: string, a: CommentAnchor, resolved: boolean): CommentThread => ({
      id,
      anchor: a,
      messages: [],
      resolved,
      stale: false,
    });
    const threads = [thread('t1', anchor('new', 1, 1), true), thread('t2', anchor('new', 2, 2), false)];
    const pre = document.createElement('pre');
    pre.append(column([{ line: 1 }, { line: 2 }]));
    markThreadRows(pre, tintedAnchors({ threads, showResolved: false }, 'a.ts'));
    expect(marked(pre)).toEqual(['new:2#', 'new:2']);
    markThreadRows(pre, tintedAnchors({ threads, showResolved: true }, 'a.ts'));
    expect(marked(pre)).toEqual(['new:1#', 'new:2#', 'new:1', 'new:2']);
    expect(tintedAnchors({ threads, showResolved: true }, 'b.ts')).toEqual([]);
  });
  it('clears the marks of a thread that is gone', () => {
    const pre = document.createElement('pre');
    pre.append(column([{ line: 1 }, { line: 2 }]));
    markThreadRows(pre, [anchor('new', 1, 2)]);
    markThreadRows(pre, [anchor('new', 2, 2)]);
    expect(marked(pre)).toEqual(['new:2#', 'new:2']);
    markThreadRows(pre, []);
    expect(marked(pre)).toEqual([]);
  });
});
