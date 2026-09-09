import { describe, expect, it } from 'vitest';
import { formatPrompt, parseSuggestions } from '../../src/server/comments/format.js';
import type { CommentMessage, CommentThread } from '../../src/shared/protocol.js';

const msg = (body: string, over: Partial<CommentMessage> = {}): CommentMessage => ({ id: 'm', body, createdAt: 1, updatedAt: 1, ...over });

const t = (over: Partial<Omit<CommentThread, 'anchor'>> & { anchor?: Partial<CommentThread['anchor']> }): CommentThread => ({
  id: 'x',
  messages: [msg('Rename this.')],
  resolved: false,
  stale: false,
  ...over,
  anchor: { path: 'src/a.py', side: 'new', startLine: 3, endLine: 3, quoted: 'def foo():', ...over.anchor },
});

describe('formatPrompt', () => {
  it('renders one block per thread in the agent format', () => {
    expect(formatPrompt([t({})])).toBe('src/a.py:3\n\n> def foo():\n\nRename this.\n\n---\n');
  });

  it('renders ranges, multi-line quotes, removed side and stale prefixes', () => {
    const out = formatPrompt([
      t({ anchor: { side: 'old', startLine: 3, endLine: 4, quoted: 'a\n\nb' } }),
      t({ stale: true, staleFromLine: 9, anchor: { path: 'src/b.py' } }),
    ]);
    expect(out).toBe(
      '(removed) src/a.py:3-4\n\n> a\n>\n> b\n\nRename this.\n\n---\n' +
        '\n(stale, was line 9) src/b.py:3\n\n> def foo():\n\nRename this.\n\n---\n',
    );
  });

  it('orders by path, then line, then creation', () => {
    const out = formatPrompt([
      t({ messages: [msg('third')], anchor: { path: 'z.py', startLine: 1, endLine: 1 } }),
      t({ messages: [msg('second')], anchor: { path: 'a.py', startLine: 9, endLine: 9 } }),
      t({ messages: [msg('first')], anchor: { path: 'a.py', startLine: 2, endLine: 2 } }),
    ]);
    expect(out.indexOf('first')).toBeLessThan(out.indexOf('second'));
    expect(out.indexOf('second')).toBeLessThan(out.indexOf('third'));
  });

  it('joins a thread\'s messages with a blank line, unlabelled', () => {
    const threaded = t({ messages: [msg('Is this safe?'), msg('Never mind, the lock covers it.')] });
    expect(formatPrompt([threaded])).toBe('src/a.py:3\n\n> def foo():\n\nIs this safe?\n\nNever mind, the lock covers it.\n\n---\n');
  });

  it('expands suggestion fences to ORIGINAL / SUGGESTED blocks', () => {
    const body = 'Use a set:\n\n```suggestion\ndef foo() -> set[int]:\n```\n\nand update the docstring.';
    const out = formatPrompt([t({ messages: [msg(body)] })]);
    expect(out).toBe(
      'src/a.py:3\n\n> def foo():\n\nUse a set:\n\nORIGINAL:\n```\ndef foo():\n```\nSUGGESTED:\n```\ndef foo() -> set[int]:\n```\n\nand update the docstring.\n\n---\n',
    );
  });
});

describe('parseSuggestions', () => {
  it('splits prose and fences in order, keeps plain text whole, and accepts an empty suggestion', () => {
    expect(parseSuggestions('just text')).toEqual([{ text: 'just text' }]);
    expect(parseSuggestions('```suggestion\n```')).toEqual([{ text: '', code: '' }]);
    expect(parseSuggestions('a\n```suggestion\nx\ny\n```\nb\n```suggestion\nz\n```')).toEqual([
      { text: 'a\n' },
      { text: '', code: 'x\ny' },
      { text: '\nb\n' },
      { text: '', code: 'z' },
    ]);
    // A regular code fence is prose.
    expect(parseSuggestions('```python\nx\n```')).toEqual([{ text: '```python\nx\n```' }]);
  });
});
