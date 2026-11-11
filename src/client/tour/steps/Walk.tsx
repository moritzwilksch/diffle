import { type ReactNode, useCallback, useEffect, useMemo, useRef } from 'react';
import { FilePath } from '@/client/FilePath.js';
import { type Place, placeOf } from '@/client/tour/anchor.js';
import { type LineRange, lineSpan, primitive } from '@/client/tour/document.js';
import { DiffRows, ExcerptNotice, linesLabel, useExcerpt } from '@/client/tour/primitives/Diff.js';
import { TourJump } from '@/client/tour/primitives/Jump.js';
import { excerptRows, lineSelector, type NoteSpan, noteAt, noteRows, rowSpot, walkCss } from './rows.js';
import { NoteBand, Stepper } from './Stepper.js';
import { reveal, useFocusedChild, useSteps } from './steps.js';

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
  const onLineNumberClick = useCallback(
    (spot: { side: 'deletions' | 'additions'; lineNumber: number }) => {
      const found = noteAt(rows, range.side, notes, spot);
      if (found != null) take(found === active ? null : found);
    },
    [rows, range.side, notes, take, active],
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
        <DiffRows
          fileDiff={shown.fileDiff}
          css={css}
          annotations={annotations}
          renderAnnotation={renderAnnotation}
          onLineNumberClick={onLineNumberClick}
        />
      ) : (
        <ExcerptNotice shown={shown} range={range} />
      )}
    </figure>
  );
}
