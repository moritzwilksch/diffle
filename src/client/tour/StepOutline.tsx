import { twMerge } from 'tailwind-merge';
import { useTour } from './state.js';

/** The side panel: the walk's steps in order, the current one marked; a click glides to its card. */
export function StepOutline() {
  const load = useTour((s) => s.load);
  const step = useTour((s) => s.step);
  const stale = useTour((s) => s.stale);
  const steps = load.state === 'ready' ? load.doc.steps : [];
  return (
    <nav className="flex h-full min-h-0 flex-col overflow-auto bg-surface p-3" aria-label="Steps">
      <h2 className="m-0 mb-2 text-[0.75rem] font-semibold tracking-wide text-muted uppercase">Steps</h2>
      {steps.length === 0 ? (
        <p className="m-0 text-[0.8125rem] text-muted">This tour has no numbered steps; pan the canvas to read it.</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
          {steps.map((card, i) => (
            <li key={card.id}>
              <button
                type="button"
                aria-current={i === step ? 'step' : undefined}
                className={twMerge(
                  'flex w-full cursor-pointer items-start gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-[0.8125rem] text-foreground hover:bg-hover',
                  i === step && 'bg-[color-mix(in_srgb,var(--accent)_12%,transparent)]',
                )}
                onClick={() => useTour.getState().goTo(i)}
              >
                <span
                  className={twMerge(
                    'flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full text-[0.75rem] font-semibold tabular-nums',
                    i === step ? 'bg-accent text-accent-fg' : 'bg-hover',
                  )}
                >
                  {card.step}
                </span>
                <span className="min-w-0 flex-1 leading-5">{card.title}</span>
                {stale.has(card.id) && (
                  <span
                    className="shrink-0 text-[0.6875rem] leading-5 text-warn"
                    title="Some of its lines left the review"
                  >
                    stale
                  </span>
                )}
              </button>
            </li>
          ))}
        </ol>
      )}
    </nav>
  );
}
