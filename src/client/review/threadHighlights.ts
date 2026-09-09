import type { CodeViewHandle } from '@pierre/diffs/react';
import type { CommentAnchor } from '../../shared/protocol.js';
import { pathFromItemId, visibleThreads } from '../model.js';
import { useStore, type ReviewState } from '../store.js';
import { isDeletionRow, watchRenderedRows } from './rows.js';

/**
 * Tint every line a saved comment refers to, not only the one its card hangs
 * under, so a range comment reads like the selection it was composed from.
 * The viewer only paints its own selection, so rows inside a thread's anchor
 * get `data-thread-line` here and the viewer's injected CSS colors them.
 */

/** Set on a row's content and gutter cells while the line lies inside a thread's range. */
export const THREAD_LINE_ATTR = 'data-thread-line';

/**
 * Mark the rows under `root` that lie inside one of `anchors`, and clear the mark elsewhere.
 * Each `code` column holds a gutter and a content element whose children pair up by index,
 * the same pairing the viewer uses to paint its selection.
 */
export function markThreadRows(root: ParentNode, anchors: readonly CommentAnchor[]): void {
  for (const code of root.querySelectorAll('code')) {
    const [gutter, content] = code.children;
    if (!gutter || !content) continue;
    for (let i = 0; i < content.children.length; i++) {
      const row = content.children[i];
      if (!(row instanceof HTMLElement) || row.dataset.line == null) continue;
      const line = Number(row.dataset.line);
      const side = isDeletionRow(row) ? 'old' : 'new';
      const inThread = anchors.some((a) => a.side === side && line >= a.startLine && line <= a.endLine);
      row.toggleAttribute(THREAD_LINE_ATTR, inThread);
      gutter.children[i]?.toggleAttribute(THREAD_LINE_ATTR, inThread);
    }
  }
}

/** The anchors to tint in `path`: those of the threads whose cards are shown, so a hidden resolved thread leaves no tint. */
export function tintedAnchors(state: Pick<ReviewState, 'threads' | 'showResolved'>, path: string): CommentAnchor[] {
  return visibleThreads(state)
    .filter((t) => t.anchor.path === path)
    .map((t) => t.anchor);
}

export function installThreadHighlights(
  viewer: () => CodeViewHandle<unknown> | null,
  scroller: HTMLElement,
): () => void {
  return watchRenderedRows(
    viewer,
    scroller,
    (schedule) =>
      useStore.subscribe((s, prev) => {
        if (
          s.threads !== prev.threads ||
          s.showResolved !== prev.showResolved ||
          s.loaded !== prev.loaded ||
          s.collapsed !== prev.collapsed
        )
          schedule();
      }),
    (items) => {
      const state = useStore.getState();
      for (const { id, root } of items) markThreadRows(root, tintedAnchors(state, pathFromItemId(id)));
    },
  );
}
