// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/client/api.js', () => ({ api: {} }));

// Row renders are counted through CodeLine, which every reference row draws exactly once per render.
const drawn: string[] = [];
const highlighted = new Map();
vi.mock('../../src/client/lsp/highlight.js', () => ({
  useHighlighted: () => highlighted,
  CodeLine: ({ fallback }: { fallback: string }) => {
    drawn.push(fallback);
    return fallback;
  },
}));

const { useStore } = await import('../../src/client/store.js');
const { ReferencesList } = await import('../../src/client/lsp/ReferencesList.js');

const items = ['a.ts', 'b.ts'].flatMap((path) =>
  [1, 2, 3].map((line) => ({ path, line, text: `  ${path}:${line}  ` })),
);

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  drawn.length = 0;
  // jsdom has no layout, so no scrollIntoView either.
  Element.prototype.scrollIntoView = () => {};
  useStore.setState({ references: { open: true, kind: 'references', symbol: 'x', items, index: 0 } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});

describe('ReferencesList', () => {
  it('rerenders only the rows whose selection changed when the index moves', async () => {
    await act(() => root.render(createElement(ReferencesList)));
    expect(drawn).toHaveLength(items.length);
    expect(host.querySelector('.ref.on')?.textContent).toContain('a.ts:1');
    drawn.length = 0;
    await act(() => useStore.getState().moveReference(1));
    expect(host.querySelector('.ref.on')?.textContent).toContain('a.ts:2');
    expect(drawn.sort()).toEqual(['a.ts:1', 'a.ts:2']);

    // A click on another file's row selects it and jumps.
    drawn.length = 0;
    const pick = vi.fn();
    await act(() => useStore.setState({ pickReference: pick }));
    await act(() => host.querySelectorAll<HTMLElement>('.ref')[4]!.click());
    expect(pick).toHaveBeenCalledOnce();
    expect(useStore.getState().references.index).toBe(4);
  });
});
