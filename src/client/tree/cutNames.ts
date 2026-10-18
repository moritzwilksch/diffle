import { type RefObject, useEffect } from 'react';

/** Whether the tree's own ellipsis is showing on the row's name. */
function ellipsized(row: HTMLElement): boolean {
  return Array.from(row.querySelectorAll('[data-truncate-marker]')).some((m) => getComputedStyle(m).opacity !== '0');
}

/** Whether a pinned lane covers the tail of the row's name, or the pane's scroll offset hides its head. */
function nameClipped(row: HTMLElement): boolean {
  const name = row.querySelector('[data-item-section="content"]');
  const pane = row.closest('[data-file-tree-virtualized-scroll]');
  if (!name || !pane) return false;
  const { left, right } = name.getBoundingClientRect();
  const view = pane.getBoundingClientRect();
  const lane = row.querySelector('[data-item-section="decoration"], [data-item-section="git"]');
  const edge = lane ? lane.getBoundingClientRect().left : view.left + pane.clientWidth;
  return right > edge + 0.5 || left < view.left - 0.5;
}

// A long name is cut by the tree's ellipsis, or, scrolling sideways, by the pinned lanes over its
// tail and the scroll offset over its head. On entry into a cut row, its full path becomes the
// row's `title`, and `TooltipHost` reads it right after: this capture listener on the shadow root
// runs before the host's. Rows are recycled across paths, so nothing is cached.
export function useCutNameTitles(bodyRef: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const shadow = bodyRef.current?.firstElementChild?.shadowRoot;
    if (!shadow) return;
    const onEnter = (e: Event) => {
      const row = (e.composedPath() as HTMLElement[]).find(
        (n) => n instanceof HTMLElement && n.dataset.itemPath != null,
      );
      const from = (e as PointerEvent | FocusEvent).relatedTarget;
      // Crossing between a row's own parts changes nothing.
      if (!row || (from instanceof Node && row.contains(from))) return;
      const cut = shadow.host.hasAttribute('data-hscroll') ? nameClipped(row) : ellipsized(row);
      if (cut) row.title = (row.dataset.itemPath ?? '').replace(/\/$/, '');
      else row.removeAttribute('title');
    };
    shadow.addEventListener('pointerover', onEnter, true);
    shadow.addEventListener('focusin', onEnter, true);
    return () => {
      shadow.removeEventListener('pointerover', onEnter, true);
      shadow.removeEventListener('focusin', onEnter, true);
    };
  }, [bodyRef]);
}
