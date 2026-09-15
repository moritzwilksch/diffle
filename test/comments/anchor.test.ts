import { describe, expect, it } from 'vitest';
import { compareThreads, quoteLines, relocate } from '../../src/server/comments/anchor.js';
import type { CommentThread, LineAnchor } from '../../src/shared/protocol.js';

const anchor = (startLine: number, quoted: string): LineAnchor => ({
  kind: 'line',
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

describe('compareThreads', () => {
  const thread = (id: string, a: CommentThread['anchor'], createdAt = 1): CommentThread => ({
    id,
    anchor: a,
    messages: [{ id: `${id}-m`, body: 'b', createdAt, updatedAt: createdAt }],
    resolved: false,
    stale: false,
  });

  it('orders by path, then line with the file thread first, then creation', () => {
    const threads = [
      thread('z', anchor(1, 'x')),
      thread('later-file', { kind: 'file', path: 'a.py' }, 5),
      thread('line', { ...anchor(3, 'x') }),
      thread('file', { kind: 'file', path: 'a.py' }, 2),
      thread('other', { kind: 'file', path: 'b.py' }),
    ];
    threads[0]!.anchor = { ...anchor(1, 'x'), path: 'z.py' };
    expect([...threads].sort(compareThreads).map((t) => t.id)).toEqual(['file', 'later-file', 'line', 'other', 'z']);
  });
});
