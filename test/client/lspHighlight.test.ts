// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A fake highlighter that records the order lines are tokenized in. Tests hold
// the highlighter at a chosen call so assertions never race the hook's timers.
const tokenized: string[] = [];
let calls = 0;
let holdFrom = Infinity;
let release = () => {};
let held = Promise.resolve();
vi.mock('@pierre/diffs', () => ({
  getFiletypeFromFileName: () => 'typescript',
  getSharedHighlighter: async () => {
    if (++calls > holdFrom) await held;
    return {
      codeToTokensBase: (line: string, opts: { theme: string }) => {
        tokenized.push(line);
        // The literal is pinned to SHIKI_THEMES.dark by a test below; a vi.mock factory cannot read an import.
        return [[{ content: line, color: opts.theme === 'github-dark-high-contrast' ? '#abc' : '#def' }]];
      },
    };
  },
}));

const { CodeLine, useHighlighted } = await import('../../src/client/lsp/highlight.js');
const { SHIKI_THEMES } = await import('../../src/client/theme.js');

const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts'];
const items = files.flatMap((path) => [0, 1, 2].map((n) => ({ path, text: `${path}:${n}` })));

function List({ near, theme = 'dark', rows = items }: { near: number; theme?: 'dark' | 'light'; rows?: typeof items }) {
  const map = useHighlighted(rows, theme, near);
  return createElement(
    'div',
    null,
    rows.map((it) => createElement('span', { key: it.text, className: map.has(`${it.path}\n${it.text}`) ? 'hl' : 'plain' }, createElement(CodeLine, { tokens: map.get(`${it.path}\n${it.text}`), fallback: it.text }))),
  );
}

/** Hold the highlighter from its `n`th call (0-based) until `release()`. */
function holdAt(n: number) {
  holdFrom = n;
  held = new Promise<void>((r) => {
    release = r;
  });
}
const flush = () => act(() => new Promise((r) => setTimeout(r, 40)));
const tick = () => act(() => new Promise((r) => setTimeout(r, 0)));
const firstLines = () => tokenized.filter((l) => l.endsWith(':0')).map((l) => l.split(':')[0]);

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  tokenized.length = 0;
  calls = 0;
  holdFrom = Infinity;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  release();
  await act(() => root.unmount());
  host.remove();
});

describe('useHighlighted', () => {
  it('shows plain text at once and highlights the file around the selected index first', async () => {
    await act(() => root.render(createElement(List, { near: 7 })));
    // Nothing has been awaited yet: every row is readable as plain text.
    expect(host.querySelectorAll('.plain')).toHaveLength(items.length);
    expect(host.textContent).toContain('c.ts:1');
    await flush();
    expect(host.querySelectorAll('.hl')).toHaveLength(items.length);
    expect(firstLines()).toEqual(['c.ts', 'b.ts', 'd.ts', 'a.ts']);
    expect(host.querySelector('.hl span')).toHaveProperty('style.color', 'rgb(170, 187, 204)');
  });

  it('stops the queue after unmount instead of tokenizing the remaining files', async () => {
    holdAt(1);
    await act(() => root.render(createElement(List, { near: 0 })));
    // The first file goes through; the second waits on the held highlighter.
    await tick();
    expect(tokenized).toHaveLength(3);
    await act(() => root.unmount());
    root = createRoot(host);
    release();
    await flush();
    // The file in flight finishes its chunk; the two behind it never start.
    expect(firstLines()).toEqual(['a.ts', 'b.ts']);
  });

  it('redirects the queue when the selection moves without restarting it', async () => {
    holdAt(0);
    await act(() => root.render(createElement(List, { near: 0 })));
    await tick();
    expect(tokenized).toHaveLength(0);
    // a.ts is already picked; the jump to d.ts steers every pick after it.
    await act(() => root.render(createElement(List, { near: 11 })));
    release();
    await flush();
    expect(firstLines()).toEqual(['a.ts', 'd.ts', 'c.ts', 'b.ts']);
    expect(tokenized).toHaveLength(items.length);
  });

  it('tokenizes a long file in chunks and stops mid-file on unmount', async () => {
    const rows = Array.from({ length: 450 }, (_, n) => ({ path: 'big.ts', text: `L${n}` }));
    holdAt(1);
    await act(() => root.render(createElement(List, { near: 0, rows })));
    await tick();
    // One chunk is done and the file is still pending, so no row has colors yet.
    expect(tokenized).toHaveLength(200);
    expect(host.querySelectorAll('.hl')).toHaveLength(0);
    await act(() => root.unmount());
    root = createRoot(host);
    release();
    await flush();
    // The chunk in flight finishes; the third never starts and the file is never committed.
    expect(tokenized).toHaveLength(400);
  });

  it('keeps the old colors across a theme toggle and goes plain only for new items', async () => {
    await act(() => root.render(createElement(List, { near: 0 })));
    await flush();
    holdAt(calls);
    await act(() => root.render(createElement(List, { near: 0, theme: 'light' })));
    await tick();
    expect(host.querySelectorAll('.hl')).toHaveLength(items.length);
    expect(host.querySelector('.hl span')).toHaveProperty('style.color', 'rgb(170, 187, 204)');
    release();
    await flush();
    expect(host.querySelector('.hl span')).toHaveProperty('style.color', 'rgb(221, 238, 255)');
    await act(() => root.render(createElement(List, { near: 0, theme: 'light', rows: items.slice(0, 3) })));
    expect(host.querySelectorAll('.plain')).toHaveLength(3);
  });
});

describe('theme names', () => {
  // The mock above matches on these literals; a rename here must reach it.
  it('are the ones the mocked highlighter keys on', () => {
    expect(SHIKI_THEMES).toEqual({ light: 'github-light-high-contrast', dark: 'github-dark-high-contrast' });
  });
});
