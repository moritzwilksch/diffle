import { ChevronLeft, ChevronRight, Download } from 'lucide-react';
import { useState } from 'react';
import { relativeTime } from '@/client/model.js';
import { useStore } from '@/client/store.js';
import { Button } from '@/client/ui/Button.js';
import { useTourThreads } from './comments.js';
import { type TourLoad, useTour } from './state.js';
import { TourPage } from './TourPage.js';

/** The agent's tour in the diff's place: where the walk stands, how many cards went stale, and the page. */
export function TourView() {
  const load = useTour((s) => s.load);
  const step = useTour((s) => s.step);
  const staleDiffs = useTour((s) => s.staleDiffs);
  const lost = useTourThreads().stale.length;
  if (load.state !== 'ready')
    return (
      <section className="flex h-full items-center justify-center bg-canvas text-muted" aria-label="Tour view">
        {load.state === 'error' ? `Cannot load the tour: ${load.message}` : 'No tour for this review.'}
      </section>
    );
  const { doc, tour } = load;
  const steps = doc.sections.length;
  return (
    <section className="flex h-full min-h-0 flex-col bg-canvas" aria-label="Tour view">
      <div className="flex items-center gap-2.5 border-b border-border bg-surface px-3 py-1.5 text-[0.8125rem]">
        <span className="text-muted">
          {steps} {steps === 1 ? 'section' : 'sections'} · pushed {relativeTime(tour.pushedAt)}
        </span>
        {staleDiffs > 0 && (
          <span className="text-warn" title="Their lines left the review since the tour was pushed">
            {staleDiffs} stale {staleDiffs === 1 ? 'diff' : 'diffs'}
          </span>
        )}
        {lost > 0 && (
          <span className="text-warn" title="The last push no longer holds what they are on; they are after the tour">
            {lost} {lost === 1 ? 'comment' : 'comments'} not in this tour
          </span>
        )}
        <span className="flex-1" />
        <ExportButton load={load} />
        {steps > 0 && (
          <div className="flex items-center gap-1" role="group" aria-label="Walk the sections">
            <Button
              variant="ghost"
              icon
              onClick={() => useTour.getState().move(-1)}
              disabled={step <= 0}
              title="Previous section (p)"
              aria-label="Previous section"
            >
              <ChevronLeft size="0.875rem" />
            </Button>
            <span className="min-w-20 text-center tabular-nums">
              {step < 0 ? `Section – of ${steps}` : `Section ${step + 1} of ${steps}`}
            </span>
            <Button
              variant="ghost"
              icon
              onClick={() => useTour.getState().move(1)}
              disabled={step >= steps - 1}
              title="Next section (n)"
              aria-label="Next section"
            >
              <ChevronRight size="0.875rem" />
            </Button>
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1">
        <TourPage key={tour.pushedAt} doc={doc} />
      </div>
    </section>
  );
}

/** Saves the tour as one HTML file, for a reviewer to share with their team. */
function ExportButton({ load }: { load: Extract<TourLoad, { state: 'ready' }> }) {
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      const { exportTour } = await import('./export/file.js');
      await exportTour(load);
    } catch (e) {
      useStore.getState().flash(`Cannot export the tour: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Button
      variant="ghost"
      // As tall as the icon buttons beside it, so the bar keeps its height.
      className="leading-[0.875rem]"
      onClick={() => void save()}
      disabled={saving}
      title="Save the tour as one HTML file to share"
    >
      <Download size="0.875rem" />
      {saving ? 'Exporting…' : 'Export'}
    </Button>
  );
}
