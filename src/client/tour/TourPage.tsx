import { useEffect, useRef } from 'react';
import type { TourDocument } from './document.js';
import { TourContent } from './render.js';
import { useTour } from './state.js';

/** What the keys do to the mounted page. */
export const tourPage = { scroll: (_by: number) => {} };

/** Where a heading lands when its section is taken, as a share of the page's height: the diff's gaze point. */
const EYE_FRACTION = 0.5;
/** The widest the article gets; prose inside it keeps its own measure. */
export const PAGE_WIDTH = 1400;

/**
 * The tour as an article that scrolls. Taking a section scrolls its heading to the gaze point;
 * scrolling the page makes the section at the gaze point the current one.
 */
export function TourPage({ doc }: { doc: TourDocument }) {
  const ref = useRef<HTMLDivElement>(null);
  const focus = useTour((s) => s.focus);
  const headings = (level: 'h2' | 'h3') => [...(ref.current?.querySelectorAll(`article > ${level}`) ?? [])];

  useEffect(() => {
    const page = ref.current;
    const heading = focus && headings(focus.sub == null ? 'h2' : 'h3')[focus.sub ?? focus.section];
    if (!page || !heading) return;
    const view = page.getBoundingClientRect();
    const top = page.scrollTop + heading.getBoundingClientRect().top - view.top - view.height * EYE_FRACTION;
    page.scrollTo({ top, behavior: 'smooth' });
  }, [focus]);
  useEffect(() => {
    tourPage.scroll = (by) => ref.current?.scrollBy({ top: by * (ref.current.clientHeight || 0) });
  });

  const follow = () => {
    const page = ref.current;
    if (!page) return;
    const eye = page.getBoundingClientRect().top + page.clientHeight * EYE_FRACTION;
    const read = headings('h2').filter((h) => h.getBoundingClientRect().top <= eye + 1).length - 1;
    if (read !== useTour.getState().step) useTour.setState({ step: read });
  };

  return (
    <div ref={ref} className="h-full overflow-auto" onScroll={follow}>
      {/* Room below the last section, so its heading can reach the gaze point too. */}
      <article className="tour-article markdown mx-auto px-6 pt-8 pb-[50vh]" style={{ maxWidth: PAGE_WIDTH + 48 }}>
        <TourContent of={doc.body} />
      </article>
    </div>
  );
}
