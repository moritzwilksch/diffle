import type { CodeViewHandle } from '@pierre/diffs/react';

/**
 * Rendered-row queries against a diff item's shadow root. Both columns of a
 * split diff, and both kinds of row in a unified one, carry `data-line`; a
 * deleted row is numbered on the old side and lives either under the
 * `[data-deletions]` column or as a `change-deletion` row inline.
 */
export function isDeletionRow(row: HTMLElement): boolean {
  return row.dataset.lineType === 'change-deletion' || (row.closest('code')?.hasAttribute('data-deletions') ?? false);
}

/** The rendered row for `line` on one side, or null when it is not on screen. */
export function rowOf(root: ParentNode, line: number, side: 'old' | 'new'): HTMLElement | null {
  const wantDeletion = side === 'old';
  return (
    [...root.querySelectorAll<HTMLElement>(`[data-line="${line}"]`)].find((r) => isDeletionRow(r) === wantDeletion) ??
    null
  );
}

/** One rendered item: its id and the root its rows live under (the shadow root, or the element itself). */
export interface RenderedRoot {
  id: string;
  root: ParentNode;
}

/**
 * Re-run `apply` over the rendered items whenever their rows can have changed: on scroll
 * (virtualization hands out fresh row elements), on mutations inside each item's shadow root,
 * and whenever `subscribe`'s callback fires. Passes coalesce to one per frame. Returns the teardown.
 */
export function watchRenderedRows(
  viewer: () => CodeViewHandle<unknown> | null,
  scroller: HTMLElement,
  subscribe: (schedule: () => void) => () => void,
  apply: (items: RenderedRoot[]) => void,
  onMutation: (records: MutationRecord[]) => void = () => {},
): () => void {
  let frame = 0;
  const observed = new WeakSet<Node>();
  const observer = new MutationObserver((records) => {
    onMutation(records);
    schedule();
  });
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const items: RenderedRoot[] = [];
      for (const item of viewer()?.getInstance()?.getRenderedItems() ?? []) {
        const root = item.element.shadowRoot ?? item.element;
        if (!observed.has(root)) {
          observed.add(root);
          observer.observe(root, { childList: true, subtree: true, characterData: true });
        }
        items.push({ id: item.id, root });
      }
      apply(items);
    });
  };
  scroller.addEventListener('scroll', schedule, { passive: true });
  // Items mount into the light DOM as they virtualize in; their shadow roots are observed on first paint.
  observer.observe(scroller, { childList: true, subtree: true });
  const unsubscribe = subscribe(schedule);
  schedule();
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    scroller.removeEventListener('scroll', schedule);
    unsubscribe();
  };
}
