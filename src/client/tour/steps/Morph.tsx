import { type ReactNode, useCallback, useMemo, useRef } from 'react';
import { type Place, placeOf } from '@/client/tour/anchor.js';
import { useHost } from '@/client/tour/host/host.js';
import { type MorphState, TourDrawing } from '@/client/tour/primitives/Diagram.js';
import { useSteps } from './steps.js';

const STATES: readonly { state: MorphState; label: string }[] = [
  { state: 'before', label: 'Before' },
  { state: 'after', label: 'After' },
  { state: 'diff', label: 'Diff' },
];

/** A morph's sentence on one state. */
interface StateNote {
  content: ReactNode;
  place: Place;
  /** Its index among the morph's child elements, as a thread on it names it. */
  child: number;
}

/**
 * A `diffle-morph`: one drawing in two states. The reader switches Before, After and Diff with its
 * buttons or h and l; a state's sentence shows under the drawing, and the Diff colours what was
 * added, removed and moved, with a legend of the marks it uses.
 */
export function TourMorph({ of, renderState }: { of: Element; renderState: (state: Element) => ReactNode }) {
  const { useFocusedChild } = useHost();
  const place = placeOf(of);
  const notes = useMemo(() => {
    const children = [...of.children];
    const note = (tag: string): StateNote | null => {
      const child = children.findIndex((c) => c.localName === tag);
      return child < 0 ? null : { content: renderState(children[child]!), place: placeOf(children[child]!), child };
    };
    return [note('diffle-before'), note('diffle-after')];
  }, [of, renderState]);
  const frame = useRef<HTMLElement>(null);
  const steps = useSteps(frame, STATES.length, 'first');
  const { take } = steps;
  const at = steps.active ?? 0;
  const focus = useCallback(
    (child: number) => {
      const state = notes.findIndex((n) => n?.child === child);
      if (state >= 0) take(state);
    },
    [notes, take],
  );
  useFocusedChild(place, focus);
  const { state, label } = STATES[at]!;
  const note = notes[at];
  return (
    <figure
      ref={frame}
      {...place}
      data-morph-block=""
      className="tour-block mx-0 overflow-hidden rounded-md border border-border bg-canvas"
    >
      <figcaption
        data-opaque=""
        className="flex items-center justify-end border-b border-border bg-surface px-2 py-1 text-[0.75rem]"
      >
        <div
          role="tablist"
          aria-label="States"
          data-targeted={steps.targeted || undefined}
          className="tour-morph-states"
        >
          {STATES.map((s, i) => (
            <button
              key={s.state}
              type="button"
              role="tab"
              aria-selected={i === at}
              className="tour-morph-state"
              onClick={() => take(i)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </figcaption>
      <div className="px-3">
        <TourDrawing of={of} morph={state} />
      </div>
      {state === 'diff' ? (
        <Legend of={of} />
      ) : (
        note && (
          <div {...note.place} className="tour-note">
            <span data-opaque="" className="tour-morph-chip" data-state={state}>
              {label}
            </span>
            <div className="min-w-0">{note.content}</div>
          </div>
        )
      )}
    </figure>
  );
}

/** The marks a morph's Diff uses, each drawn as it shows in the drawing. */
function Legend({ of }: { of: Element }) {
  const groups = [...of.querySelectorAll('svg g')];
  const kinds = [
    groups.some((g) => g.getAttribute('in') === 'after') && { kind: 'added', label: 'added' },
    groups.some((g) => g.getAttribute('in') === 'before') && { kind: 'removed', label: 'removed' },
    groups.some((g) => g.hasAttribute('move')) && { kind: 'moved', label: 'moved' },
    groups.some((g) => g.hasAttribute('move')) && { kind: 'was', label: 'where it was' },
  ].filter((k) => k !== false);
  return (
    <div data-opaque="" className="tour-legend">
      {kinds.map(({ kind, label }) => (
        <span key={kind}>
          <svg className="tour-legend-swatch" data-kind={kind} viewBox="0 0 14 10" aria-hidden>
            <rect x="0.75" y="0.75" width="12.5" height="8.5" rx="2" />
          </svg>
          {label}
        </span>
      ))}
    </div>
  );
}
