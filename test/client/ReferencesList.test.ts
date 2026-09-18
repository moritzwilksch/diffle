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
    expect(host.querySelector('[data-active="true"]')?.textContent).toContain('a.ts:1');
    drawn.length = 0;
    await act(() => useStore.getState().moveReference(1));
    expect(host.querySelector('[data-active="true"]')?.textContent).toContain('a.ts:2');
    expect(drawn.sort()).toEqual(['a.ts:1', 'a.ts:2']);

    // A click on another file's row selects it and jumps.
    drawn.length = 0;
    const pick = vi.fn();
    await act(() => useStore.setState({ pickReference: pick }));
    await act(() => host.querySelectorAll<HTMLElement>('[data-active]')[4]!.click());
    expect(pick).toHaveBeenCalledOnce();
    expect(useStore.getState().references.index).toBe(4);
  });

  it('scrolls a row hidden under its sticky file header back into view (issue #196)', async () => {
    useStore.setState((s) => ({ references: { ...s.references, index: 3 } }));
    await act(() => root.render(createElement(ReferencesList)));
    // jsdom has no layout: model the list scrolled so its 8px top padding precedes the sticky header.
    // The selected row is inside the scroller box but hidden under that header and its 2px margin.
    const rows = host.querySelectorAll<HTMLElement>('[data-active]');
    const list = rows[0]!.parentElement!.parentElement!;
    const rect = (top: number, bottom: number) => ({ top, bottom, height: bottom - top }) as DOMRect;
    list.getBoundingClientRect = () => rect(0, 200);
    for (const header of host.querySelectorAll('header')) {
      header.getBoundingClientRect = () => rect(8, 38);
      header.style.marginBottom = '2px';
    }
    rows[2]!.getBoundingClientRect = () => rect(20, 40);
    rows[3]!.getBoundingClientRect = () => rect(40, 60);
    list.scrollTop = 100;

    await act(() => useStore.getState().moveReference(-1));
    expect(host.querySelector('[data-active="true"]')?.textContent).toContain('a.ts:3');
    expect(list.scrollTop).toBe(80);

    // Moving back down to a row already clear of the header leaves the scroll alone.
    await act(() => useStore.getState().moveReference(1));
    expect(list.scrollTop).toBe(80);
  });
});
