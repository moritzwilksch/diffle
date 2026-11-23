import { GitCompareArrows } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { readTour } from '@/client/tour/document.js';
import { TourHostContext } from '@/client/tour/host/host.js';
import { Outline } from '@/client/tour/Outline.js';
import { TourArticle } from '@/client/tour/render.js';
import { GithubMark } from '@/client/ui/GithubMark.js';
import { retarget, stepPage, stepTarget } from '@/client/tour/steps/steps.js';
import { bakedHost } from './baked.js';
import type { BakedTour } from './data.js';
import { StepBar } from './StepBar.js';

/** How far below the page's top a taken heading lands. */
const HEADING_MARGIN = 16;

/**
 * An exported tour: its contents beside the article, as in diffle, or on a narrow screen behind a
 * bar under it. `n` / `p` take the next or previous section; `l` / `h` and the arrows step the
 * stepped block in view.
 */
export function ExportPage({ data }: { data: BakedTour }) {
  const doc = useMemo(() => readTour(data.html), [data]);
  const host = useMemo(() => bakedHost(data), [data]);
  const ref = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(-1);
  // The section a take scrolls to: current while the smooth scroll passes the ones before it, so a
  // second tap mid-scroll moves on from it. The reader's own scroll lets it go.
  const aim = useRef<number | null>(null);

  const headings = (level: 'h2' | 'h3') => [...(ref.current?.querySelectorAll(`article > ${level}`) ?? [])];
  const take = (section: number, sub?: number) => {
    const page = ref.current;
    const heading = sub == null ? headings('h2')[section] : headings('h3')[sub];
    if (!page || !heading) return;
    aim.current = sub == null ? section : null;
    if (sub == null) setCurrent(section);
    const top = heading.getBoundingClientRect().top - page.getBoundingClientRect().top - HEADING_MARGIN;
    page.scrollTo({ top: page.scrollTop + top, behavior: 'smooth' });
  };
  // The section whose heading passed the line under the page's top, the last one at the bottom.
  const follow = () => {
    const page = ref.current;
    if (!page) return;
    retarget();
    const sections = headings('h2');
    const bottom = page.scrollTop >= page.scrollHeight - page.clientHeight - 1;
    const line = page.getBoundingClientRect().top + HEADING_MARGIN + 1;
    const at = bottom ? sections.length - 1 : sections.filter((h) => h.getBoundingClientRect().top <= line).length - 1;
    if (aim.current != null && at !== aim.current && !bottom) return;
    aim.current = null;
    setCurrent(at);
  };

  const release = () => (aim.current = null);

  useLayoutEffect(() => {
    const page = ref.current!;
    stepPage.current = page;
    // The page scrolls with the keys from the start.
    page.focus({ preventScroll: true });
    const observer = new ResizeObserver(retarget);
    observer.observe(page);
    return () => observer.disconnect();
  }, []);
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const by = { h: -1, ArrowLeft: -1, l: 1, ArrowRight: 1 }[e.key] as 1 | -1 | undefined;
    if (by && stepTarget(by)) e.preventDefault();
    else if (e.key === 'n') take(Math.min(current + 1, doc.sections.length - 1));
    else if (e.key === 'p') take(Math.max(current - 1, 0));
  };
  useEffect(() => quietTitles(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const contents = (
    <>
      <Brand />
      <Outline title={doc.title} sections={doc.sections} current={current} onTake={take} />
    </>
  );
  return (
    <div className="tour-export">
      <aside className="tour-export-outline">{contents}</aside>
      <div
        ref={ref}
        tabIndex={-1}
        className="tour-export-page"
        onScroll={follow}
        onWheel={release}
        onPointerDown={release}
        onKeyDown={release}
      >
        <article className="tour-article markdown">
          <TourHostContext value={host}>
            <TourArticle of={doc.body} />
          </TourHostContext>
        </article>
      </div>
      <StepBar title={doc.title} sections={doc.sections} current={current} onTake={take} contents={contents} />
    </div>
  );
}

/** Where the diffle project lives, for whoever receives an exported tour. */
const REPOSITORY = 'https://github.com/moritzwilksch/diffle';

/** diffle's mark and name, as its header shows them, linking to the project: who made the file. */
function Brand() {
  return (
    <a className="tour-export-brand" href={REPOSITORY} target="_blank" rel="noopener" title="diffle on GitHub">
      <GitCompareArrows size="0.875rem" aria-hidden />
      <span className="tour-export-wordmark">diffle</span>
      <GithubMark size="0.875rem" />
    </a>
  );
}

/**
 * Keeps the browser's tip off a `title` that repeats its element's text shown whole, as diffle's
 * tooltips do: a path names itself on hover only when it is cut short. Returns the cleanup.
 */
function quietTitles(): () => void {
  const over = (e: PointerEvent) => {
    const el = (e.target as Element).closest<HTMLElement>('[title]');
    const text = el?.getAttribute('title');
    if (!el || !text || text !== el.textContent?.trim() || el.scrollWidth > el.clientWidth) return;
    el.removeAttribute('title');
    el.addEventListener('pointerleave', () => el.setAttribute('title', text), {
      once: true,
    });
  };
  document.addEventListener('pointerover', over);
  return () => document.removeEventListener('pointerover', over);
}
