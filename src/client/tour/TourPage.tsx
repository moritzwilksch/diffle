import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { reviewGeometry } from '@/client/review/geometry.js';
import { remPx } from '@/client/scale.js';
import { useStore } from '@/client/store.js';
import { anchorTop } from './anchor.js';
import {
  DRAFT,
  threadAt,
  tourArticle,
  useActiveCard,
  useTextHighlights,
  useTourDraft,
  useTourThreads,
} from './comments.js';
import type { TourDocument } from './document.js';
import { InlineThreads, Margin, SelectionComment, StaleThreads } from './Margin.js';
import { TourArticle } from './render.js';
import { useTour } from './state.js';

/** What the keys do to the mounted page. */
export const tourPage = { scroll: (_by: number) => {} };

/**
 * How far below the page's top a taken section's heading lands: the gap the diff keeps above a file
 * header it lands, so both views land a heading alike.
 */
const headingMargin = () => reviewGeometry(remPx()).layout.gap;
/**
 * The article's one column: a card's diff shows a 100-character line unwrapped. `PAGE_WIDTH` in
 * crates/diffle/src/tour/layout.rs words the warnings with it.
 */
export const PAGE_WIDTH = 920;
/** How long a glide may take before the scroll follows the reader again, whether or not it got there. */
const GLIDE_MS = 1000;
/** Room on each side of the column, in pixels so the column is exactly `PAGE_WIDTH`. */
const GUTTER = 24;
/** The narrowest column the margin leaves; narrower, the threads go inline. */
const MIN_COLUMN = 680;
/** The margin's width, in rem, and the gap before it, in pixels. */
const MARGIN_REM = 18;
const MARGIN_GAP = 24;
/** Where a revealed thread's anchor lands: the diff's gaze point (`EYE_FRACTION` in ReviewPane.tsx). */
const EYE_FRACTION = 0.5;

/** The column's width, and whether the margin fits beside it, on a page `width` pixels wide. */
export function tourLayout(width: number, rem: number): { column: number; margin: boolean } {
  const beside = Math.min(PAGE_WIDTH, width - 2 * GUTTER - MARGIN_GAP - MARGIN_REM * rem);
  if (beside >= MIN_COLUMN) return { column: beside, margin: true };
  return { column: Math.min(PAGE_WIDTH, width - 2 * GUTTER), margin: false };
}

/**
 * The tour as an article that scrolls. Taking a section scrolls its heading to the top, or the page
 * as far as it goes; scrolling the page makes the section whose heading passed that line the current
 * one, and the last one at the bottom. A taken section stays current until the reader scrolls.
 */
export function TourPage({ doc }: { doc: TourDocument }) {
  const ref = useRef<HTMLDivElement>(null);
  /** Where a taken section's glide ends; null once it got there or the reader took over. */
  const landing = useRef<number | null>(null);
  const [article, setArticle] = useState<HTMLElement | null>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  /** Counts the article's resizes: a diff that loads moves what the threads are on. */
  const [layout, setLayout] = useState(0);
  const [hovered, setHovered] = useState<string | null>(null);
  const { live } = useTourThreads();
  const draft = useTourDraft();
  const active = useActiveCard(hovered);
  const reveal = useTour((s) => s.reveal);
  const { column, margin } = tourLayout(width, remPx());
  const anchors = useMemo(
    () => [...live.map((t) => ({ id: t.id, anchor: t.anchor })), ...(draft ? [{ id: DRAFT, anchor: draft }] : [])],
    [live, draft],
  );
  useTextHighlights(article, anchors, active, layout);

  useLayoutEffect(() => {
    const page = ref.current;
    if (!page || !article) return;
    tourArticle.current = article;
    setWidth(page.clientWidth);
    const observer = new ResizeObserver(() => {
      setWidth(page.clientWidth);
      setLayout((n) => n + 1);
    });
    observer.observe(page);
    observer.observe(article);
    return () => {
      observer.disconnect();
      if (tourArticle.current === article) tourArticle.current = null;
    };
  }, [article]);

  // A thread opened from elsewhere: its anchor at the gaze point, or its card among the lost ones.
  useEffect(() => {
    const page = ref.current;
    if (!page || !article || !reveal) return;
    const thread = useStore.getState().threads.find((t) => t.id === reveal.id);
    if (thread?.anchor.kind !== 'tour') return;
    const top = thread.stale
      ? page.querySelector(`[data-thread="${CSS.escape(thread.id)}"]`)?.getBoundingClientRect().top
      : anchorTop(article, thread.anchor);
    if (top == null) return;
    const view = page.getBoundingClientRect();
    landing.current = null;
    page.scrollTo({
      top: page.scrollTop + top - view.top - page.clientHeight * EYE_FRACTION,
      behavior: 'smooth',
    });
  }, [reveal, article]);
  const focus = useTour((s) => s.focus);
  const headings = (level: 'h2' | 'h3') => [...(ref.current?.querySelectorAll(`article > ${level}`) ?? [])];

  useEffect(() => {
    const page = ref.current;
    const heading = focus && headings(focus.sub == null ? 'h2' : 'h3')[focus.sub ?? focus.section];
    if (!page || !heading) return;
    const view = page.getBoundingClientRect();
    const top = page.scrollTop + heading.getBoundingClientRect().top - view.top - headingMargin();
    const end = Math.round(Math.max(0, Math.min(top, page.scrollHeight - page.clientHeight)));
    landing.current = Math.abs(end - page.scrollTop) > 1 ? end : null;
    page.scrollTo({ top: end, behavior: 'smooth' });
    // A glide that stopped short, as when a diff loading above moved its target, ends all the same.
    const timer = setTimeout(() => {
      if (landing.current === end) landing.current = null;
    }, GLIDE_MS);
    return () => clearTimeout(timer);
  }, [focus]);
  useEffect(() => {
    tourPage.scroll = (by) => {
      landing.current = null;
      ref.current?.scrollBy({ top: by * (ref.current.clientHeight || 0) });
    };
  });

  const follow = () => {
    const page = ref.current;
    if (!page) return;
    // A glide, and its landing, leave the section taken current: near the end it cannot reach the top.
    if (landing.current != null) {
      if (Math.abs(page.scrollTop - landing.current) <= 1) landing.current = null;
      return;
    }
    const sections = headings('h2');
    const bottom = page.scrollTop >= page.scrollHeight - page.clientHeight - 1;
    const line = page.getBoundingClientRect().top + headingMargin();
    const read = bottom
      ? sections.length - 1
      : sections.filter((h) => h.getBoundingClientRect().top <= line + 1).length - 1;
    if (read !== useTour.getState().step) useTour.setState({ step: read });
  };

  return (
    <div
      ref={ref}
      className="h-full overflow-auto"
      onScroll={follow}
      // The reader scrolling takes over from a glide.
      onWheel={() => (landing.current = null)}
      onTouchStart={() => (landing.current = null)}
    >
      <div className="tour-layout" style={{ gap: margin ? MARGIN_GAP : 0 }}>
        <div ref={columnRef} className="relative min-w-0" style={{ width: column + 2 * GUTTER, paddingInline: GUTTER }}>
          <article
            ref={setArticle}
            className="tour-article markdown"
            onClick={(e) => {
              if (!article || !document.getSelection()?.isCollapsed) return;
              const id = threadAt(article, live, e.clientX, e.clientY);
              if (id) useStore.getState().focusThread(id);
            }}
          >
            <TourArticle of={doc.body} after={margin ? undefined : (i) => <InlineThreads index={i} />} />
          </article>
          <StaleThreads />
          {!margin && <SelectionComment article={article} container={columnRef} at="end" />}
        </div>
        {margin && (
          <div style={{ width: `${MARGIN_REM}rem` }} className="shrink-0">
            <Margin article={article} layout={layout} onHover={setHovered} hovered={hovered} />
          </div>
        )}
      </div>
    </div>
  );
}
