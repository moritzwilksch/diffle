import { useEffect, useMemo } from 'react';
import { compareThreads } from '@/client/comments/threads.js';
import { visibleThreads } from '@/client/model.js';
import { useStore, type TourDraft } from '@/client/store.js';
import type { CommentThread, TourAnchor } from '@/shared/protocol.js';
import { selectionTarget, type Spot, textRange } from './anchor.js';

/** A thread on the tour, its anchor narrowed. */
export type TourThread = CommentThread & { anchor: TourAnchor };

function isTourThread(t: CommentThread): t is TourThread {
  return t.anchor.kind === 'tour';
}

/** The shown tour threads in document order: those the tour holds, and the stale ones it lost. */
export function useTourThreads(): { live: TourThread[]; stale: TourThread[] } {
  const threads = useStore((s) => s.threads);
  const showResolved = useStore((s) => s.showResolved);
  return useMemo(() => {
    const shown = visibleThreads({ threads, showResolved }).filter(isTourThread).sort(compareThreads);
    return { live: shown.filter((t) => !t.stale), stale: shown.filter((t) => t.stale) };
  }, [threads, showResolved]);
}

export function useTourDraft(): TourDraft | null {
  return useStore((s) => (s.draft?.kind === 'tour' ? s.draft : null));
}

/** The card the reader is at: the draft, a reply being written, the focused thread, or the hovered one. */
export function useActiveCard(hovered: string | null): string | null {
  return useStore((s) => {
    if (s.draft?.kind === 'tour') return DRAFT;
    return s.replyTo ?? s.focusedThread ?? hovered;
  });
}

/** The draft's id among the margin's cards. */
export const DRAFT = 'draft';

/** The article the tour page shows, for `c` to read the selection in. */
export const tourArticle: { current: HTMLElement | null } = { current: null };

/** Opens a draft on the selected words; false when nothing in the article is selected. */
export function commentOnSelection(): boolean {
  const article = tourArticle.current;
  if (!article) return false;
  const found = selectionTarget(document.getSelection(), article);
  if (!found) return false;
  const review = useStore.getState();
  if ('refused' in found) review.flash(found.refused);
  else review.openTourDraft(found.node, found.target);
  return true;
}

const HIGHLIGHT = 'tour-comment';
const HIGHLIGHT_ACTIVE = 'tour-comment-active';

/**
 * Tints the words each thread and the draft are on through the CSS Custom Highlight API, which
 * leaves the rendered article untouched; the active one stronger. `layout` changes whenever the page
 * may have re-rendered the words.
 */
export function useTextHighlights(
  article: HTMLElement | null,
  anchors: readonly { id: string; anchor: Spot }[],
  active: string | null,
  layout: unknown,
): void {
  useEffect(() => {
    if (!article || typeof CSS === 'undefined' || !('highlights' in CSS)) return;
    const quiet = new Highlight();
    const loud = new Highlight();
    for (const { id, anchor } of anchors) {
      const range = textRange(article, anchor);
      if (range) (id === active ? loud : quiet).add(range);
    }
    CSS.highlights.set(HIGHLIGHT, quiet);
    CSS.highlights.set(HIGHLIGHT_ACTIVE, loud);
    return () => {
      CSS.highlights.delete(HIGHLIGHT);
      CSS.highlights.delete(HIGHLIGHT_ACTIVE);
    };
  }, [article, anchors, active, layout]);
}

/** The thread whose words lie under the point, for a click on a highlight. */
export function threadAt(article: HTMLElement, threads: readonly TourThread[], x: number, y: number): string | null {
  for (const t of threads) {
    const rects = textRange(article, t.anchor)?.getClientRects() ?? [];
    if ([...rects].some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) return t.id;
  }
  return null;
}
