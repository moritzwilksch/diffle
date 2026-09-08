import { describe, expect, it } from 'vitest';
import { quoteLines, relocate } from '../../src/server/comments/anchor.js';
import type { CommentAnchor } from '../../src/shared/protocol.js';

const anchor = (startLine: number, quoted: string): CommentAnchor => ({
  path: 'a.py',
  side: 'new',
  startLine,
  endLine: startLine + quoted.split('\n').length - 1,
  quoted,
});

describe('quoteLines', () => {
  it('extracts an inclusive 1-based range', () => {
    expect(quoteLines('a\nb\nc\nd\n', 2, 3)).toBe('b\nc');
  });
});

describe('relocate', () => {
  it('keeps an anchor whose text has not moved', () => {
    expect(relocate(anchor(2, 'b'), 'a\nb\nc\n')).toEqual(anchor(2, 'b'));
  });

  it('follows text that shifted down', () => {
    expect(relocate(anchor(2, 'b\nc'), 'x\ny\na\nb\nc\n')).toEqual({ ...anchor(2, 'b\nc'), startLine: 4, endLine: 5 });
  });

  it('prefers the match nearest the original line', () => {
    const contents = 'x\nx\nx\nx\nx\nx\nx\nx\n';
    expect(relocate(anchor(6, 'x'), contents)?.startLine).toBe(6);
    expect(relocate(anchor(20, 'x'), contents)?.startLine).toBe(8);
  });

  it('returns null when the text is gone', () => {
    expect(relocate(anchor(1, 'gone'), 'a\nb\n')).toBeNull();
  });

  it('requires all lines of a block to match contiguously', () => {
    expect(relocate(anchor(1, 'a\nc'), 'a\nb\nc\n')).toBeNull();
  });
});
