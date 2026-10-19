import type { CodeViewHandle } from '@pierre/diffs/react';
import { watchRenderedRows } from './rows.js';

/**
 * Visible spaces and tabs, like refined-github's: each run of spaces and each tab in a rendered
 * row is wrapped in a `data-ws` span that the viewer's injected CSS (`WHITESPACE_CSS`) paints.
 * The spans keep the original characters, so layout, selection, copying, and the text-node
 * walkers (search, occurrences, word navigation) see the same text as before.
 */

/** Set on the span around a run of spaces (`space`) or a single tab (`tab`). */
export const WHITESPACE_ATTR = 'data-ws';

/** Injected into the viewer's shadow DOM. Paints without taking room, so no row changes height or width. */
export const WHITESPACE_CSS = `
[data-ws] { --ws-color: color-mix(in srgb, var(--fg-2) 55%, transparent); }
/* One centered dot per character cell; in a monospace font a space is 1ch wide. */
[data-ws='space'] {
  background: radial-gradient(circle, var(--ws-color) 0.07em, transparent 0.09em) 0 50% / 1ch 1lh repeat-x;
}
[data-ws='tab'] { position: relative; }
[data-ws='tab']::before {
  content: '→'; position: absolute; left: 0; color: var(--ws-color); pointer-events: none; user-select: none;
}
`;

const RUN = /( +|\t)/;

/** Wrap the whitespace in `row`'s text that is not wrapped yet. */
export function markWhitespace(row: Element): void {
  const walker = row.ownerDocument.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  const pending: Text[] = [];
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null)
    if (!n.parentElement?.hasAttribute(WHITESPACE_ATTR) && RUN.test(n.data)) pending.push(n);
  for (const text of pending) {
    const parts = text.data.split(RUN).filter(Boolean);
    text.replaceWith(
      ...parts.map((part) => {
        if (!RUN.test(part)) return part;
        const span = row.ownerDocument.createElement('span');
        span.setAttribute(WHITESPACE_ATTR, part === '\t' ? 'tab' : 'space');
        span.textContent = part;
        return span;
      }),
    );
  }
}

export function installWhitespaceMarks(
  viewer: () => CodeViewHandle<unknown, undefined> | null,
  scroller: HTMLElement,
): () => void {
  // Rows already marked; a mutation inside one (the viewer re-rendering it, or our own wrapping) drops it.
  const marked = new WeakSet<Element>();
  return watchRenderedRows(
    viewer,
    scroller,
    () => () => {},
    (items) => {
      for (const { root } of items)
        for (const row of root.querySelectorAll('[data-line]')) {
          if (marked.has(row)) continue;
          markWhitespace(row);
          marked.add(row);
        }
    },
    (records) => {
      for (const r of records) {
        const el = r.target instanceof Element ? r.target : r.target.parentElement;
        const row = el?.closest('[data-line]');
        if (row) marked.delete(row);
      }
    },
  );
}
