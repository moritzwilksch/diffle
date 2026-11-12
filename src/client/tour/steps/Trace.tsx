import { type ReactNode, useEffect, useMemo, useRef } from 'react';
import { FilePath } from '@/client/FilePath.js';
import { type Place, placeOf } from '@/client/tour/anchor.js';
import { primitive } from '@/client/tour/document.js';
import { useHost } from '@/client/tour/host/host.js';
import { ExcerptNotice, useExcerpt } from '@/client/tour/primitives/Diff.js';
import { TourJump } from '@/client/tour/primitives/Jump.js';
import type { Side } from '@/shared/protocol.js';
import { excerptRows, lineSelector, litCss, noteRows, rowSpot } from './rows.js';
import { NoteBand, StepBadge, Stepper } from './Stepper.js';
import { reveal, useSteps } from './steps.js';

/** Lines shown on each side of a stop's line. */
const AROUND = 3;

/** One stop of a trace, as the article renders it. */
interface Stop {
  path: string;
  side: Side;
  line: number;
  content: ReactNode;
  place: Place;
}

/** The stops of the trace `source`, in call order, each sentence rendered by `render`. */
function readStops(source: Element, render: (stop: Element) => ReactNode): Stop[] {
  return [...source.children].flatMap((el) => {
    const stop = primitive(el);
    if (stop?.tag !== 'diffle-stop') return [];
    const side = stop.side ?? 'new';
    return [{ path: stop.path, side, line: Number(stop.line), content: render(el), place: placeOf(el) }];
  });
}

/**
 * A path through the code in call order, one stop at a time: a tab per stop with its file's name,
 * the shared stepper, and the stop's line lit among a few lines around it, with its sentence under
 * the line. It starts on its first stop. A stop whose line left the review says so in place.
 */
export function TourTrace({
  source,
  renderNote,
}: {
  source: Element;
  /** A stop's sentence as the article renders inline prose; the same function on every render. */
  renderNote: (stop: Element) => ReactNode;
}) {
  const { Rows, useFocusedChild } = useHost();
  const place = placeOf(source);
  const stops = useMemo(() => readStops(source, renderNote), [source, renderNote]);
  const frame = useRef<HTMLElement>(null);
  const steps = useSteps(frame, stops.length, 'first');
  const { take } = steps;
  useFocusedChild(place, take);
  const at = steps.active ?? 0;
  const stop = stops[at];
  const range = useMemo(
    () => ({ path: stop?.path ?? '', side: stop?.side ?? 'new', start: stop?.line ?? 1, end: stop?.line ?? 1 }),
    [stop],
  );
  const shown = useExcerpt(range, AROUND);
  const rows = useMemo(() => (shown.state === 'ready' ? excerptRows(shown.patch) : []), [shown]);
  const css = useMemo(() => litCss(rows, range.side, range), [rows, range]);
  const lit = noteRows(rows, range.side, range);
  const annotations = useMemo(() => {
    if (!lit) return [];
    const { side, lineNumber } = rowSpot(rows[lit[1]]!);
    return [{ side, lineNumber, metadata: at }];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, at]);
  // A stop the reader takes comes into view with its sentence, as far as the page must scroll; the
  // first stop, shown from the start, scrolls nothing.
  const revealed = useRef(at);
  useEffect(() => {
    if (!lit || revealed.current === at) return;
    revealed.current = at;
    const first = rowSpot(rows[lit[0]]!);
    const frameId = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const row = frame.current?.querySelector('diffs-container')?.shadowRoot?.querySelector(lineSelector(first));
        const band = frame.current?.querySelector('.tour-note');
        if (row && band) reveal(row.getBoundingClientRect().top, band.getBoundingClientRect().bottom);
      }),
    );
    return () => cancelAnimationFrame(frameId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);
  if (!stop) return null;

  return (
    <figure
      ref={frame}
      {...place}
      data-trace=""
      className="tour-block mx-0 overflow-hidden rounded-md border border-border bg-canvas"
    >
      <div data-opaque="" className="flex items-center border-b border-border bg-surface text-[0.75rem]">
        <div className="flex min-w-0 flex-1 items-center overflow-x-auto">
          {stops.map((s, i) => (
            <button
              key={i}
              type="button"
              className="tour-trace-stop"
              aria-pressed={i === at}
              title={`${s.path}:${s.line}`}
              onClick={() => take(i)}
            >
              <StepBadge number={i + 1} active={i === at} />
              {s.path.split('/').pop()}
            </button>
          ))}
        </div>
        <div className="flex-none px-2">
          <Stepper titles={stops.map((s) => `${s.path}:${s.line}`)} label="Stop" steps={steps} />
        </div>
      </div>
      <figcaption
        data-opaque=""
        className="flex items-center gap-1.5 border-b border-border bg-surface px-2 py-1 text-[0.75rem]"
      >
        <FilePath path={stop.path} className="min-w-0 flex-1" nowrap />
        <span className="shrink-0 font-mono text-muted">
          {stop.side === 'old' ? 'before ' : ''}
          {stop.line}
        </span>
        <TourJump path={stop.path} line={stop.line} side={stop.side} label="Open" placed />
      </figcaption>
      {shown.state === 'ready' ? (
        <Rows
          patch={shown.patch}
          css={css}
          annotations={annotations}
          renderAnnotation={({ metadata }: { metadata: number }) => (
            <NoteBand place={stops[metadata]!.place} number={metadata + 1}>
              {stops[metadata]!.content}
            </NoteBand>
          )}
        />
      ) : (
        <ExcerptNotice shown={shown} range={range} />
      )}
    </figure>
  );
}
