import { type ReactNode, useCallback, useEffect, useMemo, useRef } from 'react';
import { type Place, placeOf } from '@/client/tour/anchor.js';
import { primitive } from '@/client/tour/document.js';
import { useFocusedChild } from '@/client/tour/margin/tourThreads.js';
import { TourDrawing } from '@/client/tour/primitives/Diagram.js';
import { NoteBand, Stepper } from './Stepper.js';
import { reveal, useSteps } from './steps.js';

/** A diagram's note: the step of its number. */
interface DiagramNote {
  title: string;
  content: ReactNode;
  place: Place;
  /** Its index among the diagram's child elements, as a thread on it names it. */
  child: number;
}

/**
 * A `diffle-diagram`: a drawing, or, when it holds notes, a drawing stepped through one note at a
 * time. A taken step lights its groups (edge, face, lines and arrowheads in the accent) and dims
 * the other steps' groups, and its note shows under the drawing.
 */
export function TourDiagram({ of, renderNote }: { of: Element; renderNote: (note: Element) => ReactNode }) {
  const notes = useMemo(
    () =>
      [...of.children].flatMap((el, child) => {
        const note = primitive(el);
        if (note?.tag !== 'diffle-note') return [];
        return [{ title: note.title, content: renderNote(el), place: placeOf(el), child }];
      }),
    [of, renderNote],
  );
  if (!notes.length) return <TourDrawing of={of} place={placeOf(of)} />;
  return <SteppedDiagram of={of} notes={notes} />;
}

function SteppedDiagram({ of, notes }: { of: Element; notes: readonly DiagramNote[] }) {
  const place = placeOf(of);
  const frame = useRef<HTMLElement>(null);
  const steps = useSteps(frame, notes.length, 'rest');
  const { active, take } = steps;
  const focus = useCallback(
    (child: number) => {
      const at = notes.findIndex((n) => n.child === child);
      if (at >= 0) take(at);
    },
    [notes, take],
  );
  useFocusedChild(place, focus);
  // The drawing and the note under it come into view, as far as the page must scroll.
  useEffect(() => {
    if (active == null) return;
    const frameId = requestAnimationFrame(() => {
      const box = frame.current?.getBoundingClientRect();
      if (box) reveal(box.top, box.bottom);
    });
    return () => cancelAnimationFrame(frameId);
  }, [active]);
  const note = active == null ? null : notes[active]!;
  return (
    <figure
      ref={frame}
      {...place}
      data-stepped=""
      className="tour-block mx-0 overflow-hidden rounded-md border border-border bg-canvas"
    >
      <figcaption
        data-opaque=""
        className="flex items-center justify-end border-b border-border bg-surface px-2 py-1 text-[0.75rem]"
      >
        <Stepper titles={notes.map((n) => n.title)} label="Step" steps={steps} />
      </figcaption>
      <div className="px-3">
        <TourDrawing of={of} active={active == null ? null : active + 1} />
      </div>
      {note && (
        <NoteBand place={note.place} number={active! + 1} title={note.title}>
          {note.content}
        </NoteBand>
      )}
    </figure>
  );
}
