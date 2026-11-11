import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Place } from '@/client/tour/anchor.js';
import type { Steps } from './steps.js';

/**
 * A stepped block's controls: a step back, each step by number, a step on. They hold their places
 * on every step, so a click lands where it did before; no step's title ever sits among them.
 * Clicking the taken number returns to rest where the block has one.
 */
export function Stepper({ titles, label, steps }: { titles: readonly string[]; label: string; steps: Steps }) {
  const { active, take, step } = steps;

  const arrow =
    'grid size-5 cursor-pointer place-items-center rounded-sm border-0 bg-transparent p-0 text-muted hover:bg-hover disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent';
  return (
    <div role="group" aria-label={`${label}s`} data-targeted={steps.targeted || undefined} className="tour-stepper">
      <button
        type="button"
        className={arrow}
        disabled={steps.atStart}
        onClick={() => step(-1)}
        title={`Previous ${label.toLowerCase()} (h)`}
      >
        <ChevronLeft size="0.875rem" />
      </button>
      {titles.map((title, i) => (
        <button
          key={i}
          type="button"
          className="tour-step"
          aria-pressed={i === active}
          aria-label={`${label} ${i + 1}: ${title}`}
          title={title}
          onClick={() => take(i === active && steps.rests ? null : i)}
        >
          {i + 1}
        </button>
      ))}
      <button
        type="button"
        className={arrow}
        disabled={active === titles.length - 1}
        onClick={() => step(1)}
        title={`Next ${label.toLowerCase()} (l)`}
      >
        <ChevronRight size="0.875rem" />
      </button>
    </div>
  );
}

/** A taken step's text in a compact full-width band: its number, its title when it has one, its sentence. */
export function NoteBand({
  place,
  number,
  title,
  children,
}: {
  place: Place;
  number: number;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div {...place} className="tour-note">
      <span data-opaque="" className="tour-note-number" aria-hidden>
        {number}
      </span>
      <div className="min-w-0">
        {title && <div className="tour-note-title">{title}</div>}
        <div>{children}</div>
      </div>
    </div>
  );
}
