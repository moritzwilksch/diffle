import { twMerge } from 'tailwind-merge';
import type { TourCard } from '@/client/tour/document.js';
import { TourContent } from '@/client/tour/render.js';

/** The page column's width, which every card takes. */
export const CARD_W = 440;

/**
 * A card of the page: its step number and title over its contents. The current step takes the
 * accent; a card whose lines left the review says so in its header.
 */
export function Card({ card, current, stale }: { card: TourCard; current: boolean; stale: boolean }) {
  return (
    <article
      data-card={card.id}
      aria-label={card.step == null ? card.title : `Step ${card.step}: ${card.title}`}
      aria-current={current ? 'step' : undefined}
      className={twMerge(
        'flex flex-col rounded-lg border bg-canvas shadow-card',
        current ? 'border-accent ring-2 ring-[color-mix(in_srgb,var(--accent)_30%,transparent)]' : 'border-border',
      )}
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        {card.step != null && (
          <span
            className={twMerge(
              'flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1 text-[0.75rem] font-semibold tabular-nums',
              current ? 'bg-accent text-accent-fg' : 'bg-hover text-foreground',
            )}
          >
            {card.step}
          </span>
        )}
        <h3 className="m-0 min-w-0 flex-1 text-[0.875rem] leading-snug font-semibold">{card.title}</h3>
        {stale && (
          <span className="shrink-0 text-[0.6875rem] text-warn" title="Some of its lines are no longer in the review">
            stale
          </span>
        )}
      </header>
      <div className="markdown px-3 py-2 text-[0.8125rem] [word-break:break-word]">
        <TourContent of={card.body} />
      </div>
    </article>
  );
}
