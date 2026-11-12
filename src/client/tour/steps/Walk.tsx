import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Side } from '@/shared/side.js';
import { FilePath } from '@/client/FilePath.js';
import { type Place, placeOf } from '@/client/tour/anchor.js';
import { type LineRange, lineSpan, primitive } from '@/client/tour/document.js';
import { useHost } from '@/client/tour/host/host.js';
import { ExcerptNotice, linesLabel, useExcerpt } from '@/client/tour/primitives/Diff.js';
import { TourJump } from '@/client/tour/primitives/Jump.js';
import {
  excerptRows,
  gutterSelector,
  lineSelector,
  type NoteSpan,
  noteRows,
  rowSpot,
  type WalkRow,
  walkCss,
} from './rows.js';
import { NoteBand, StepBadge, Stepper } from './Stepper.js';
import { reveal, type Steps, useSteps } from './steps.js';

/** One note of a walk, as the article renders it. */
interface WalkNote extends NoteSpan {
  title: string;
  /** Its sentence, rendered. */
  content: ReactNode;
  place: Place;
}

/** The notes of the walk `source`, in its order, each rendered by `render`. */
function readNotes(source: Element, render: (note: Element) => ReactNode): WalkNote[] {
  return [...source.children].flatMap((el) => {
    const note = primitive(el);
    if (note?.tag !== 'diffle-note' || note.lines == null) return [];
    const [start, end] = lineSpan(note.lines);
    return [{ start, end, title: note.title, content: render(el), place: placeOf(el) }];
  });
}

/**
 * A diff walked one note at a time, full width. At rest it shows plainly, with each note's number
 * on the gutter of its first line. A note taken (its number there or in the header, or `h` / `l`)
 * lights its lines, dims the rest, and shows its text under its last line. Stepping scrolls the
 * page only as far as the lit lines need.
 */
export function TourWalk({
  source,
  range,
  renderNote,
}: {
  source: Element;
  range: LineRange;
  /** A note's sentence as the article renders inline prose; the same function on every render. */
  renderNote: (note: Element) => ReactNode;
}) {
  const { Rows, useFocusedChild } = useHost();
  const place = placeOf(source);
  const notes = useMemo(() => readNotes(source, renderNote), [source, renderNote]);
  const shown = useExcerpt(range);
  const figure = useRef<HTMLElement>(null);
  const steps = useSteps(figure, notes.length, 'rest');
  const { active, take } = steps;
  useFocusedChild(place, take);
  const rows = useMemo(() => (shown.state === 'ready' ? excerptRows(shown.patch) : []), [shown]);

  const lit = active == null ? null : noteRows(rows, range.side, notes[active]!);
  // Once the band hangs under the lit lines, they and the band come into view.
  useEffect(() => {
    if (!lit) return;
    const first = rowSpot(rows[lit[0]]!);
    const frame = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const host = figure.current?.querySelector('diffs-container');
        const row = host?.shadowRoot?.querySelector(lineSelector(first));
        const band = figure.current?.querySelector('.tour-note');
        if (row && band) reveal(row.getBoundingClientRect().top, band.getBoundingClientRect().bottom);
      }),
    );
    return () => cancelAnimationFrame(frame);
    // `lit` is new each render; the note and the rows decide what it is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, rows]);

  const css = useMemo(() => walkCss(rows, range.side, notes, active), [rows, range.side, notes, active]);
  const annotations = useMemo(() => {
    if (!lit || active == null) return [];
    const { side, lineNumber } = rowSpot(rows[lit[1]]!);
    return [{ side, lineNumber, metadata: active }];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, rows]);
  const renderAnnotation = useCallback(
    ({ metadata }: { metadata: number }) => {
      const note = notes[metadata]!;
      return (
        <NoteBand place={note.place} number={metadata + 1} title={note.title}>
          {note.content}
        </NoteBand>
      );
    },
    [notes],
  );

  return (
    <figure
      ref={figure}
      {...place}
      data-walk=""
      className="tour-block mx-0 overflow-hidden rounded-md border border-border bg-canvas"
    >
      <figcaption
        data-opaque=""
        className="flex items-center gap-1.5 border-b border-border bg-surface px-2 py-1 text-[0.75rem]"
      >
        <FilePath path={range.path} className="min-w-0 flex-1" nowrap />
        <span className="shrink-0 font-mono text-muted">
          {range.side === 'old' ? 'before ' : ''}
          {linesLabel(range)}
        </span>
        {shown.state === 'ready' && <Stepper titles={notes.map((n) => n.title)} label="Note" steps={steps} />}
        <TourJump path={range.path} line={range.start} side={range.side} label="Open" placed />
      </figcaption>
      {shown.state === 'ready' ? (
        <div className="relative">
          <Rows patch={shown.patch} css={css} annotations={annotations} renderAnnotation={renderAnnotation} />
          <Marks rows={rows} side={range.side} notes={notes} steps={steps} />
        </div>
      ) : (
        <ExcerptNotice shown={shown} range={range} />
      )}
    </figure>
  );
}

/** Where a note's badge sits: level with its first line, in pixels from the diff's top. */
interface Mark {
  note: number;
  top: number;
}

/**
 * Each note's badge in the lane left of the line numbers, level with its first line; a click takes
 * the note, or rests the walk when it is taken. The header's numbers are the controls a keyboard
 * or a screen reader uses, so these stay out of the tab order.
 */
function Marks({
  rows,
  side,
  notes,
  steps,
}: {
  rows: readonly WalkRow[];
  side: Side;
  notes: readonly WalkNote[];
  steps: Steps;
}) {
  const lane = useRef<HTMLDivElement>(null);
  const [marks, setMarks] = useState<Mark[]>([]);
  useEffect(() => {
    const box = lane.current?.parentElement;
    if (!box) return;
    // The diff renders its rows after a highlighter pass and resizes as a band opens; each moves them.
    const measure = () => {
      const root = box.querySelector('diffs-container')?.shadowRoot;
      const origin = box.getBoundingClientRect().top;
      const found = notes.flatMap((note, i) => {
        const lit = noteRows(rows, side, note);
        const cell = lit && root?.querySelector(gutterSelector(rowSpot(rows[lit[0]]!)));
        if (!cell) return [];
        const rect = cell.getBoundingClientRect();
        return [{ note: i, top: rect.top - origin + (rect.height - 20) / 2 }];
      });
      setMarks((prev) => (JSON.stringify(prev) === JSON.stringify(found) ? prev : found));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    const host = box.querySelector('diffs-container');
    if (host) observer.observe(host);
    return () => observer.disconnect();
  }, [rows, side, notes, steps.active]);
  return (
    <div ref={lane} aria-hidden data-opaque="">
      {marks.map(({ note, top }) => (
        <button
          key={note}
          type="button"
          tabIndex={-1}
          data-mark={note + 1}
          className="tour-walk-mark"
          style={{ top }}
          title={notes[note]!.title}
          onClick={() => steps.take(note === steps.active ? null : note)}
        >
          <StepBadge number={note + 1} active={note === steps.active} />
        </button>
      ))}
    </div>
  );
}
