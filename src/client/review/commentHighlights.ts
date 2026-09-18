import type { CodeViewHandle } from '@pierre/diffs/react';
import type { LineAnchor } from '../../shared/protocol.js';
import type { ResolvedRange } from '../comments/anchor.js';
import { draftRange, pathFromItemId, visibleThreads } from '../model.js';
import { useStore, type ReviewState } from '../store.js';
import { isDeletionRow, watchRenderedRows } from './rows.js';

/**
 * Tint every line a comment refers to, not only the one its card hangs under,
 * so a range comment reads like the selection it was composed from. The draft
 * is tinted the same way: the viewer paints only its own selection, and the
 * cursor moves on while the composer stays open. Rows inside a range get
 * `data-comment-line` here and the viewer's injected CSS colors them.
 */

/** Set on a row's content and gutter cells while the line lies inside a comment's range. */
export const COMMENT_LINE_ATTR = 'data-comment-line';

/**
 * Mark the rows under `root` that lie inside one of `ranges`, and clear the mark elsewhere.
 * Each `code` column holds a gutter and a content element whose children pair up by index,
 * the same pairing the viewer uses to paint its selection.
 */
export function markCommentRows(root: ParentNode, ranges: readonly ResolvedRange[]): void {
  for (const code of root.querySelectorAll('code')) {
    const [gutter, content] = code.children;
    if (!gutter || !content) continue;
    for (let i = 0; i < content.children.length; i++) {
      const row = content.children[i];
      if (!(row instanceof HTMLElement) || row.dataset.line == null) continue;
      const line = Number(row.dataset.line);
      const side = isDeletionRow(row) ? 'old' : 'new';
      const inRange = ranges.some((r) => r.side === side && line >= r.startLine && line <= r.endLine);
      row.toggleAttribute(COMMENT_LINE_ATTR, inRange);
      gutter.children[i]?.toggleAttribute(COMMENT_LINE_ATTR, inRange);
    }
  }
}

/**
 * The ranges to tint in `path`: those of the line threads whose cards are shown, so a hidden
 * resolved thread leaves no tint, plus the draft's while one is open there. A file thread or
 * a file draft has no lines to tint.
 */
export function tintedRanges(
  state: Pick<ReviewState, 'threads' | 'showResolved' | 'draft' | 'loaded'>,
  path: string,
): ResolvedRange[] {
  const ranges: ResolvedRange[] = visibleThreads(state)
    .map((t) => t.anchor)
    .filter((a): a is LineAnchor => a.kind === 'line' && a.path === path);
  const draft = state.draft?.path === path ? draftRange(state) : null;
  if (draft) ranges.push(draft);
  return ranges;
}

export function installCommentHighlights(
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
          s.draft !== prev.draft ||
          s.loaded !== prev.loaded ||
          s.collapsed !== prev.collapsed
        )
          schedule();
      }),
    (items) => {
      const state = useStore.getState();
      for (const { id, root } of items) markCommentRows(root, tintedRanges(state, pathFromItemId(id)));
    },
  );
}
