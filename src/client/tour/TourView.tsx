import { ChevronLeft, ChevronRight } from 'lucide-react';
import { relativeTime } from '@/client/model.js';
import { Button } from '@/client/ui/Button.js';
import { useTour } from './state.js';
import { TourCanvas } from './TourCanvas.js';

/** The agent's tour in the diff's place: where the walk stands, how many cards went stale, and the canvas. */
export function TourView() {
  const load = useTour((s) => s.load);
  const step = useTour((s) => s.step);
  const stale = useTour((s) => s.stale);
  if (load.state !== 'ready')
    return (
      <section className="flex h-full items-center justify-center bg-canvas text-muted" aria-label="Tour view">
        {load.state === 'error' ? `Cannot load the tour: ${load.message}` : 'No tour for this review.'}
      </section>
    );
  const { doc, tour } = load;
  const steps = doc.steps.length;
  return (
    <section className="flex h-full min-h-0 flex-col bg-canvas" aria-label="Tour view">
      <div className="flex items-center gap-2.5 border-b border-border bg-surface px-3 py-1.5 text-[0.8125rem]">
        <span className="text-muted">
          {steps} {steps === 1 ? 'step' : 'steps'} · {doc.cards.length} {doc.cards.length === 1 ? 'card' : 'cards'} ·
          pushed {relativeTime(tour.pushedAt)}
        </span>
        {stale.size > 0 && (
          <span className="text-warn" title="Their lines left the review since the tour was pushed">
            {stale.size} stale {stale.size === 1 ? 'card' : 'cards'}
          </span>
        )}
        <span className="flex-1" />
        {steps > 0 && (
          <div className="flex items-center gap-1" role="group" aria-label="Walk the tour">
            <Button
              variant="ghost"
              icon
              onClick={() => useTour.getState().move(-1)}
              disabled={step <= 0}
              title="Previous step (p)"
              aria-label="Previous step"
            >
              <ChevronLeft size="0.875rem" />
            </Button>
            <span className="min-w-20 text-center tabular-nums">
              {step < 0 ? `Step – of ${steps}` : `Step ${step + 1} of ${steps}`}
            </span>
            <Button
              variant="ghost"
              icon
              onClick={() => useTour.getState().move(1)}
              disabled={step >= steps - 1}
              title="Next step (n)"
              aria-label="Next step"
            >
              <ChevronRight size="0.875rem" />
            </Button>
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1">
        <TourCanvas key={tour.pushedAt} doc={doc} />
      </div>
    </section>
  );
}
