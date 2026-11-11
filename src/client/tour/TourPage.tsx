import { useEffect, useMemo, useRef } from 'react';
import { pageOrder, type TourDocument } from './document.js';
import { Card, CARD_W } from './primitives/Card.js';
import { useTour } from './state.js';

/** What the keys do to the mounted page. */
export const tourPage = { scroll: (_by: number) => {} };

/** Room left above a card taller than the page when a step lands on it. */
const TOP_MARGIN = 16;

/**
 * The tour as one scrolling column: its cards in reading order, a group's cards in a titled
 * section. Taking a step scrolls its card to the gaze point, or to the top when it is taller.
 */
export function TourPage({ doc }: { doc: TourDocument }) {
  const ref = useRef<HTMLDivElement>(null);
  const steps = useTour((s) => (s.load.state === 'ready' ? s.load.doc.steps : []));
  const step = useTour((s) => s.step);
  const focus = useTour((s) => s.focus);
  const stale = useTour((s) => s.stale);
  const sections = useMemo(() => pageOrder(doc), [doc]);
  const current = steps[step]?.id;

  useEffect(() => {
    const page = ref.current;
    const card = focus && page?.querySelector(`[data-card="${CSS.escape(focus.id)}"]`);
    if (!page || !card) return;
    const view = page.getBoundingClientRect();
    const box = card.getBoundingClientRect();
    const above = box.height <= view.height ? (view.height - box.height) / 2 : TOP_MARGIN;
    page.scrollTo({ top: page.scrollTop + box.top - view.top - above, behavior: 'smooth' });
  }, [focus]);
  useEffect(() => {
    tourPage.scroll = (by) => ref.current?.scrollBy({ top: by * (ref.current.clientHeight || 0) });
  });

  const card = (c: TourDocument['cards'][number]) => (
    <Card key={c.id} card={c} current={c.id === current} stale={stale.has(c.id)} />
  );
  return (
    <div ref={ref} className="h-full overflow-auto">
      <div className="mx-auto flex flex-col gap-4 px-4 py-6" style={{ maxWidth: CARD_W }}>
        {sections.map((s, i) =>
          s.title == null ? (
            card(s.cards[0]!)
          ) : (
            <section
              key={`group:${i}`}
              aria-label={s.title}
              className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-3"
            >
              <h2 className="m-0 text-[0.8125rem] font-semibold text-muted">{s.title}</h2>
              {s.cards.map(card)}
            </section>
          ),
        )}
      </div>
    </div>
  );
}
