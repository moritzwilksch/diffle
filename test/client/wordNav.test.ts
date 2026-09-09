// @vitest-environment jsdom
import type { CodeViewHandle } from '@pierre/diffs/react';
import { afterEach, expect, it, vi } from 'vitest';
import { clearWordFocus, moveWord, moveWordToEdge, setViewer } from '../../src/client/lsp/wordNav.js';
import { lspTarget } from '../../src/client/lsp/target.js';
import { wordsIn } from '../../src/client/lsp/words.js';

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

it('uses UTF-16 offsets for Unicode words and skips punctuation', () => {
  expect(wordsIn('𐐀.x_2 + 42')).toEqual([
    { start: 0, text: '𐐀' },
    { start: 3, text: 'x_2' },
    { start: 9, text: '42' },
  ]);
});
