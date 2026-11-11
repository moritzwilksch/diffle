import { useEffect, useRef } from 'react';
import type { TourDocument } from './document.js';
import { TourArticle } from './render.js';
import { useTour } from './state.js';

/** What the keys do to the mounted page. */
export const tourPage = { scroll: (_by: number) => {} };

/**
 * Where a section's heading lands when it is taken, as a share of the page's height from its top.
 * Higher than the diff's gaze point: a reader of an article wants the section below its heading,
 * not the end of the one before.
 */
const HEADING_FRACTION = 0.15;
/**
 * The article's one column: a card's diff shows a 100-character line unwrapped. `PAGE_WIDTH` in
 * crates/diffle/src/tour/layout.rs words the warnings with it.
 */
export const PAGE_WIDTH = 920;
/** How long a glide may take before the scroll follows the reader again, whether or not it got there. */
const GLIDE_MS = 1000;
/** Room on each side of the column, in pixels so the column is exactly `PAGE_WIDTH`. */
const GUTTER = 24;

/**
 * The tour as an article that scrolls. Taking a section scrolls its heading near the top; scrolling
 * the page makes the section whose heading passed that line the current one. While a taken section
 * is still gliding into place, the scroll leaves the section taken alone.
 */
export function TourPage({ doc }: { doc: TourDocument }) {
  const ref = useRef<HTMLDivElement>(null);
  /** Where a taken section's glide ends; null once it got there or the reader took over. */
  const landing = useRef<number | null>(null);
  const focus = useTour((s) => s.focus);
  const headings = (level: 'h2' | 'h3') => [...(ref.current?.querySelectorAll(`article > ${level}`) ?? [])];

  useEffect(() => {
    const page = ref.current;
    const heading = focus && headings(focus.sub == null ? 'h2' : 'h3')[focus.sub ?? focus.section];
    if (!page || !heading) return;
    const view = page.getBoundingClientRect();
    const top = page.scrollTop + heading.getBoundingClientRect().top - view.top - view.height * HEADING_FRACTION;
    const end = Math.round(Math.max(0, Math.min(top, page.scrollHeight - page.clientHeight)));
    landing.current = Math.abs(end - page.scrollTop) > 1 ? end : null;
    page.scrollTo({ top: end, behavior: 'smooth' });
    // A glide that stopped short, as when a diff loading above moved its target, ends all the same.
    const timer = setTimeout(() => {
      if (landing.current !== end) return;
      landing.current = null;
      page.dispatchEvent(new Event('scroll'));
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
    if (landing.current != null) {
      if (Math.abs(page.scrollTop - landing.current) > 1) return;
      landing.current = null;
    }
    const line = page.getBoundingClientRect().top + page.clientHeight * HEADING_FRACTION;
    const read = headings('h2').filter((h) => h.getBoundingClientRect().top <= line + 1).length - 1;
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
      {/* Room below the last section, so its heading can reach that line too. */}
      <article
        className="tour-article markdown mx-auto pt-8 pb-[85vh]"
        style={{ maxWidth: PAGE_WIDTH + 2 * GUTTER, paddingInline: GUTTER }}
      >
        <TourArticle of={doc.body} />
      </article>
    </div>
  );
}
