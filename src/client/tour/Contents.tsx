import { MessageSquare } from 'lucide-react';
import { CommentPanel } from '@/client/comments/CommentPanel.js';
import { useTourThreads } from './margin/tourThreads.js';
import { Outline } from './Outline.js';
import { useTour } from './state.js';

/** How a comment starts in the tour, which its empty comment panel says. */
const TOUR_HINT =
  'Select words and press c to comment on them. Hover a block for its Comment button, or click a box in a diagram.';

/**
 * The tour's side panel: its contents as tall as they need, up to a share of the height, over the
 * diff view's comment panel, which lists every thread, the code's and the tour's. Each scrolls alone.
 */
export function TourSide() {
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="max-h-[45%] shrink-0 overflow-auto border-b border-b-border">
        <TourContents />
      </div>
      <div className="flex min-h-0 flex-1 flex-col [&>aside]:flex-1">
        <CommentPanel hint={TOUR_HINT} openTourThread={useTour.getState().revealThread} />
      </div>
    </div>
  );
}

/**
 * The table of contents, each `h2` a step of the walk with its `h3`s under it. It marks the
 * section read, those holding a diff whose lines left the review, and how many comments each holds.
 */
export function TourContents() {
  const load = useTour((s) => s.load);
  const step = useTour((s) => s.step);
  const stale = useTour((s) => s.stale);
  const { live } = useTourThreads();
  if (load.state !== 'ready') return null;
  const comments = (index: number) => live.filter((t) => t.anchor.step === index + 1).length;
  return (
    <Outline
      title={load.doc.title}
      sections={load.doc.sections}
      current={step}
      onTake={(section, sub) => useTour.getState().goTo(section, sub)}
      marks={(index) => (
        <>
          {comments(index) > 0 && (
            <span className="flex shrink-0 items-center gap-0.5 text-[0.6875rem] leading-5 text-muted">
              <MessageSquare size="0.6875rem" aria-label="comments" />
              {comments(index)}
            </span>
          )}
          {stale.has(index) && (
            <span className="shrink-0 text-[0.6875rem] leading-5 text-warn" title="A diff in it left the review">
              stale
            </span>
          )}
        </>
      )}
    />
  );
}
