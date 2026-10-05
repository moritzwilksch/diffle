// @vitest-environment jsdom
import type { CodeViewHandle } from '@pierre/diffs/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  clearWordFocus,
  focusToken,
  moveWord,
  moveWordToEdge,
  onSelectionChanged,
  setViewer,
  wordsIn,
} from '../../src/client/lsp/wordNav.js';
import { lspTarget } from '../../src/client/lsp/target.js';

vi.mock('../../src/client/model.js', () => ({
  itemIdOf: () => 'file.py',
  pathFromItemId: () => 'file.py',
}));
vi.mock('../../src/client/store.js', () => ({
  useStore: {
    getState: () => ({
      selection: { id: 'file.py', range: { start: 1, end: 1 } },
      moveCursor: () => {},
      flash: () => {},
      occurrences: null,
      clearOccurrences: () => {},
      requestOccurrences: async () => null,
    }),
  },
}));

afterEach(() => {
  clearWordFocus();
  setViewer(() => null);
  vi.unstubAllGlobals();
});

it('walks every word inside a span in both directions, preserving LSP columns', () => {
  const highlights = new Map<string, Set<Range>>();
  vi.stubGlobal('CSS', { highlights });
  vi.stubGlobal(
    'Highlight',
    class extends Set<Range> {
      constructor(...ranges: Range[]) {
        super(ranges);
      }
    },
  );
  const highlightedText = () => [...(highlights.get('diffle-word-focus') ?? [])].map((range) => range.toString());
  const element = document.createElement('div');
  element.innerHTML = '<div data-line="1"><span data-char="4">foo.bar(42, baz)</span></div>';
  setViewer(
    () =>
      ({
        getInstance: () => ({ getRenderedItems: () => [{ id: 'file.py', element }] }),
      }) as unknown as CodeViewHandle<unknown>,
  );
  for (const [text, col] of [
    ['foo', 4],
    ['bar', 8],
    ['42', 12],
    ['baz', 16],
  ] as const) {
    moveWord(1);
    expect(lspTarget.get()).toEqual({ path: 'file.py', side: 'new', line: 1, col, text });
    expect(highlightedText()).toEqual([text]);
    expect(element.querySelector('.lsp-focus')).toBeNull();
  }
  moveWord(-1);
  expect(lspTarget.get()).toMatchObject({ text: '42', col: 12 });
  moveWord(-1);
  expect(lspTarget.get()).toMatchObject({ text: 'bar', col: 8 });
  expect(highlightedText()).toEqual(['bar']);
  moveWordToEdge('first');
  expect(lspTarget.get()).toMatchObject({ text: 'foo', col: 4 });
  moveWordToEdge('last');
  expect(lspTarget.get()).toMatchObject({ text: 'baz', col: 16 });
  expect(highlightedText()).toEqual(['baz']);
  clearWordFocus();
  expect(highlights.has('diffle-word-focus')).toBe(false);
  expect(element.textContent).toBe('foo.bar(42, baz)');
});

it('keeps the focus while the cursor stays on the focused row and drops it once it leaves', () => {
  const highlights = new Map<string, Set<Range>>();
  vi.stubGlobal('CSS', { highlights });
  vi.stubGlobal(
    'Highlight',
    class extends Set<Range> {
      constructor(...ranges: Range[]) {
        super(ranges);
      }
    },
  );
  const element = document.createElement('div');
  element.innerHTML = '<div data-line="3"><span data-char="0">amount = price</span></div>';
  setViewer(
    () =>
      ({
        getInstance: () => ({ getRenderedItems: () => [{ id: 'file.py', element }] }),
      }) as unknown as CodeViewHandle<unknown>,
  );
  // A click focuses the word, then puts the line cursor on its row: the same row, so the focus holds.
  const token = element.querySelector<HTMLElement>('span')!;
  focusToken({ path: 'file.py', side: 'new', line: 3, col: 9, text: 'price' }, token);
  expect(lspTarget.get()).toMatchObject({ text: 'price', col: 9 });
  onSelectionChanged({ id: 'file.py', range: { start: 3, end: 3 } });
  expect(lspTarget.get()).toMatchObject({ text: 'price' });
  expect(highlights.has('diffle-word-focus')).toBe(true);
  // Another row, or no row: the focus goes.
  onSelectionChanged({ id: 'file.py', range: { start: 4, end: 4 } });
  expect(lspTarget.get()).toBeNull();
  expect(highlights.has('diffle-word-focus')).toBe(false);
  // Only new-side words can be focused: a deleted row's text has no server position.
  focusToken({ path: 'file.py', side: 'old', line: 3, col: 0, text: 'amount' }, token);
  expect(lspTarget.get()).toBeNull();
});

it('uses UTF-16 offsets for Unicode words and skips punctuation', () => {
  expect(wordsIn('𐐀.x_2 + 42')).toEqual([
    { start: 0, text: '𐐀' },
    { start: 3, text: 'x_2' },
    { start: 9, text: '42' },
  ]);
});
