import { ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import type { TourSection } from '@/client/tour/document.js';

/**
 * A narrow screen's way through an exported tour, under the article where a thumb reaches it: the
 * previous and next section either side of the one read, which opens `contents` as a sheet over
 * the bar. Taking anything in the sheet closes it.
 */
export function StepBar({
  title,
  sections,
  current,
  onTake,
  contents,
}: {
  title: string | null;
  sections: readonly TourSection[];
  current: number;
  onTake: (section: number) => void;
  contents: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);
  // The sheet opens on the entry read, however long the contents run.
  useLayoutEffect(() => {
    if (open) sheet.current?.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest' });
  }, [open]);
  const section = sections[current];

  return (
    <div className="tour-export-bar">
      {open && (
        <>
          <div className="tour-export-backdrop" onClick={() => setOpen(false)} />
          <div
            ref={sheet}
            className="tour-export-sheet"
            onClick={(e) => (e.target as Element).closest('button, a') && setOpen(false)}
          >
            {contents}
          </div>
        </>
      )}
      <button
        type="button"
        className="tour-export-step"
        aria-label="Previous section"
        disabled={current <= 0}
        onClick={() => onTake(current - 1)}
      >
        <ChevronLeft size="1.25rem" aria-hidden />
      </button>
      <button type="button" className="tour-export-where" aria-expanded={open} onClick={() => setOpen(!open)}>
        {section && (
          <span className="tour-export-count">
            {current + 1}/{sections.length}
          </span>
        )}
        <span className="tour-export-label">{section?.title ?? title ?? 'Contents'}</span>
        <ChevronUp size="1rem" aria-hidden className="tour-export-caret" />
      </button>
      <button
        type="button"
        className="tour-export-step"
        aria-label="Next section"
        disabled={current >= sections.length - 1}
        onClick={() => onTake(current + 1)}
      >
        <ChevronRight size="1.25rem" aria-hidden />
      </button>
    </div>
  );
}
