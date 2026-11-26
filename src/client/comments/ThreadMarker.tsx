import type { CodeViewHandle } from '@pierre/diffs/react';
import type { Side } from '@/shared/side.js';
import { Button } from '@/client/ui/Button.js';
import { MessageSquare } from 'lucide-react';
import { isDeletionRow, watchRenderedRows } from '@/client/review/rows.js';
import { setInlineExpanded } from './inlineExpansion.js';

export interface ThreadMarker {
  key: string;
  label: string;
  open: boolean;
  defaultOpen: boolean;
}

export interface LineThreadMarker extends ThreadMarker {
  line: number;
  side: Side;
}

export const THREAD_GUTTER_CSS = `
[data-thread-markers] { display: inline-flex; gap: 1px; margin-inline-end: .25ch; vertical-align: middle; }
[data-thread-marker] {
  display: inline-grid;
  place-items: center;
  inline-size: 1.05lh;
  block-size: .9lh;
  padding: 0;
  border: 0;
  border-radius: 3px;
  background: var(--diffs-bg);
  color: var(--accent);
  cursor: pointer;
}
[data-thread-marker]:is(:hover, :focus-visible, [aria-expanded="true"]) {
  background: var(--diffs-selection-base);
  color: var(--diffs-bg);
}
`;

export function FileThreadMarker({ marker }: { marker: ThreadMarker }) {
  return (
    <Button
      variant="ghost"
      icon
      className="mx-2 my-0.5"
      aria-label={marker.label}
      aria-expanded={marker.open}
      title={marker.label}
      onClick={() => setInlineExpanded(marker.key, !marker.open, marker.defaultOpen)}
    >
      <MessageSquare size="0.875rem" />
    </Button>
  );
}

function buttonFor(marker: ThreadMarker): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.threadMarker = marker.key;
  button.setAttribute('aria-label', marker.label);
  button.setAttribute('aria-expanded', String(marker.open));
  button.title = marker.label;
  button.innerHTML =
    '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  // A marker click opens the thread instead of starting a selection on its number cell.
  button.onpointerdown = (event) => event.stopPropagation();
  button.onkeydown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
  };
  button.onclick = (event) => {
    event.stopPropagation();
    setInlineExpanded(marker.key, !marker.open, marker.defaultOpen);
  };
  return button;
}

/** Attach markers to the actual number cells as CodeView virtualizes its rows. */
export function installThreadMarkers(
  viewer: () => CodeViewHandle<unknown, undefined> | null,
  scroller: HTMLElement,
  byItem: ReadonlyMap<string, LineThreadMarker[]>,
): () => void {
  return watchRenderedRows(
    viewer,
    scroller,
    () => () => {},
    (items) => {
      for (const { id, root } of items) {
        const markers = byItem.get(id);
        if (!markers) {
          for (const group of root.querySelectorAll('[data-thread-markers]')) group.remove();
          continue;
        }
        const byLine = new Map<string, LineThreadMarker[]>();
        for (const marker of markers) {
          const key = `${marker.side}:${marker.line}`;
          const at = byLine.get(key);
          if (at) at.push(marker);
          else byLine.set(key, [marker]);
        }
        for (const cell of root.querySelectorAll<HTMLElement>('[data-column-number]')) {
          const side = isDeletionRow(cell) ? 'old' : 'new';
          const at = byLine.get(`${side}:${cell.dataset.columnNumber}`);
          const group = cell.querySelector<HTMLElement>(':scope > [data-thread-markers]');
          if (!at) {
            group?.remove();
            continue;
          }
          const signature = JSON.stringify(at);
          if (group?.dataset.threadMarkers === signature) continue;
          const next = group ?? document.createElement('span');
          next.dataset.threadMarkers = signature;
          next.replaceChildren(...at.map(buttonFor));
          if (!group) cell.prepend(next);
        }
      }
    },
  );
}
