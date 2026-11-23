import { CircleCheck, FlaskConical, OctagonX, TriangleAlert } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef } from 'react';
import { type Place, placeOf } from '@/client/tour/anchor.js';
import { type LineRange, primitive, rangeOf } from '@/client/tour/document.js';
import { oneSide } from '@/client/tour/excerpt.js';
import { useHost } from '@/client/tour/host/host.js';
import { ExcerptNotice, useExcerpt } from '@/client/tour/primitives/Diff.js';
import type { TourOutcome } from '@/shared/tour-catalog.js';
import { StepBadge, Stepper } from './Stepper.js';
import { reveal, useSteps } from './steps.js';

/** One run's part of a step: its sentence, its place, how it ends up. */
interface Run {
  content: ReactNode;
  place: Place;
  range: LineRange | null;
  tone?: TourOutcome;
}

/** A step of the runs: one both take, or what each does; a run that has ended takes none. */
type Step =
  | { shared: true; run: Run; place: Place; title: string }
  | { shared: false; before: Run | null; after: Run | null; place: Place; title: string };

const OUTCOMES = {
  success: { Icon: CircleCheck, label: 'works' },
  warning: { Icon: TriangleAlert, label: 'fails, handled' },
  error: { Icon: OctagonX, label: 'fails' },
} satisfies Record<TourOutcome, unknown>;

/** The steps of the versus `source`, each sentence rendered by `render`. */
function readSteps(source: Element, render: (part: Element) => ReactNode): Step[] {
  const run = (el: Element): Run => {
    const element = primitive(el);
    const tone = element?.tag === 'diffle-before' || element?.tag === 'diffle-after' ? element.tone : undefined;
    return { content: render(el), place: placeOf(el), range: element && rangeOf(element), tone };
  };
  return [...source.children].flatMap((el): Step[] => {
    if (primitive(el)?.tag !== 'diffle-step') return [];
    const runs = [...el.children];
    const before = runs.find((r) => r.localName === 'diffle-before');
    const after = runs.find((r) => r.localName === 'diffle-after');
    const title = ((after ?? before ?? el).textContent ?? '').trim().replace(/\s+/g, ' ');
    if (!before && !after) return [{ shared: true, run: run(el), place: placeOf(el), title }];
    return [
      {
        shared: false,
        before: before ? run(before) : null,
        after: after ? run(after) : null,
        place: placeOf(el),
        title,
      },
    ];
  });
}

/**
 * Two runs of the code on one input, side by side, step for step: the old code on the left, the new
 * on the right. A step both take spans both columns; where they part, each column holds its run's
 * step, coloured by how it ends up. Each step shows the line it names, as the diff shows it. At
 * rest every step shows; a taken step is lit and the others dim.
 */
export function TourVersus({
  source,
  input,
  renderStep,
}: {
  source: Element;
  input: string;
  /** A step's sentence as the article renders inline prose; the same function on every render. */
  renderStep: (part: Element) => ReactNode;
}) {
  const { useFocusedChild } = useHost();
  const place = placeOf(source);
  const steps = useMemo(() => readSteps(source, renderStep), [source, renderStep]);
  const frame = useRef<HTMLElement>(null);
  const stepping = useSteps(frame, steps.length, 'rest');
  const { active, take } = stepping;
  const focus = useCallback((child: number) => take(child), [take]);
  useFocusedChild(place, focus);
  useEffect(() => {
    if (active == null) return;
    const row = frame.current?.querySelector(`[data-row="${active}"]`);
    if (!row) return;
    const id = requestAnimationFrame(() => {
      const box = row.getBoundingClientRect();
      reveal(box.top, box.bottom);
    });
    return () => cancelAnimationFrame(id);
  }, [active]);
  const tones = new Set(
    steps.flatMap((s) => (s.shared ? [] : [s.before?.tone, s.after?.tone])).filter((t) => t != null),
  );
  return (
    <figure
      ref={frame}
      {...place}
      data-versus=""
      data-stepping={active != null || undefined}
      className="tour-block mx-0 overflow-hidden rounded-md border border-border bg-canvas"
    >
      <figcaption
        data-opaque=""
        className="flex items-center gap-2 border-b border-border bg-surface px-2 py-1 text-[0.75rem]"
      >
        <FlaskConical size="0.875rem" className="shrink-0 text-muted" aria-hidden />
        <span className="shrink-0 font-semibold">Input</span>
        <span className="min-w-0 flex-1 truncate" title={input}>
          {input}
        </span>
        <Stepper titles={steps.map((s) => s.title)} label="Step" steps={stepping} />
      </figcaption>
      <div className="tour-versus">
        {/* Two lanes, the old run's and the new run's, either side of the spine the steps sit on. */}
        <div data-opaque="" className="tour-versus-lane" data-lane="before" aria-hidden>
          Before
        </div>
        <div data-opaque="" className="tour-versus-spine" aria-hidden />
        <div data-opaque="" className="tour-versus-lane" data-lane="after" aria-hidden>
          After
        </div>
        {steps.map((step, i) => (
          <div
            key={i}
            {...step.place}
            data-row={i}
            data-lit={i === active || undefined}
            data-shared={step.shared || undefined}
            className="tour-versus-row"
          >
            <button
              type="button"
              className="tour-versus-mark"
              aria-label={`Step ${i + 1}`}
              onClick={() => take(i === active ? null : i)}
            >
              <StepBadge number={i + 1} active={i === active} />
            </button>
            {step.shared ? (
              <RunCell run={step.run} wide />
            ) : (
              <>
                <RunCell run={step.before} lane="before" />
                <RunCell run={step.after} lane="after" />
              </>
            )}
          </div>
        ))}
      </div>
      {tones.size > 0 && (
        <div data-opaque="" className="tour-legend">
          {(['success', 'warning', 'error'] as const)
            .filter((t) => tones.has(t))
            .map((t) => {
              const { Icon, label } = OUTCOMES[t];
              return (
                <span key={t} data-tone={t}>
                  <Icon size="0.75rem" aria-hidden />
                  {label}
                </span>
              );
            })}
        </div>
      )}
    </figure>
  );
}

/** One run's part of a step in its lane, or a shared step across both: its sentence, marked by its outcome, over the line it names. */
function RunCell({ run, wide = false, lane }: { run: Run | null; wide?: boolean; lane?: 'before' | 'after' }) {
  if (!run) {
    return (
      <div data-opaque="" className="tour-versus-cell" data-lane={lane} data-ended="">
        Run ended
      </div>
    );
  }
  const outcome = run.tone && OUTCOMES[run.tone];
  // A shared step's sentence is its own element, whose place the row carries.
  const place = wide ? {} : run.place;
  return (
    <div {...place} className="tour-versus-cell" data-lane={lane} data-tone={run.tone} data-wide={wide || undefined}>
      <div className="flex gap-1.5">
        {outcome && <outcome.Icon size="0.875rem" className="tour-versus-outcome" aria-label={outcome.label} />}
        <div className="min-w-0">{run.content}</div>
      </div>
      {run.range && <RunLine range={run.range} />}
    </div>
  );
}

/** The line a run's step names, on its run's side as the diff marks it, under its file and number. */
function RunLine({ range }: { range: LineRange }) {
  const { Rows } = useHost();
  const shown = useExcerpt(range);
  const patch = useMemo(() => (shown.state === 'ready' ? oneSide(shown.patch, range.side) : ''), [shown, range.side]);
  return (
    <div data-opaque="" className="tour-versus-line">
      <RunPlace range={range} />
      <div className="tour-versus-code">
        {shown.state === 'ready' ? (
          <Rows patch={patch} path={range.side === 'new' ? range.path : undefined} />
        ) : (
          <ExcerptNotice shown={shown} range={range} />
        )}
      </div>
    </div>
  );
}

/** A run's file and line, a quiet link into the diff where one stands behind the tour. */
function RunPlace({ range }: { range: LineRange }) {
  const { open } = useHost();
  const label = `${range.path.split('/').pop()}:${range.start}`;
  if (!open) return <span className="tour-versus-place">{label}</span>;
  return (
    <button
      type="button"
      className="tour-versus-place"
      title={`Open ${range.path}:${range.start}${range.side === 'old' ? ' (before)' : ''} in the diff`}
      onClick={() => open(range.path, range.start, range.side)}
    >
      {label}
    </button>
  );
}
