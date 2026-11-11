import { ChevronLeft, ChevronRight } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FilePath } from '@/client/FilePath.js';
import { useStore } from '@/client/store.js';
import { type Place, placeOf } from '@/client/tour/anchor.js';
import { type LineRange, lineSpan, primitive } from '@/client/tour/document.js';
import {
  excerptRows,
  lineSelector,
  type NoteSpan,
  noteAt,
  noteRows,
  reveal,
  rowSpot,
  walkCss,
  walks,
} from '@/client/tour/walk.js';
import { DiffRows, ExcerptNotice, linesLabel, useExcerpt } from './Diff.js';
import { TourJump } from './Jump.js';

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
    if (note?.tag !== 'diffle-note') return [];
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
  const [active, setActive] = useState<number | null>(null);
  const figure = useRef<HTMLElement>(null);
  const rows = useMemo(() => (shown.state === 'ready' ? excerptRows(shown.patch) : []), [shown]);
  const step = useCallback(
    (by: 1 | -1) =>
      setActive((at) => {
        if (at == null) return by > 0 ? 0 : null;
        const next = at + by;
        return next < 0 ? null : Math.min(next, notes.length - 1);
      }),
    [notes.length],
  );
  useEffect(() => {
    const el = figure.current;
    if (!el) return;
    walks.set(el, step);
    return () => void walks.delete(el);
  }, [step]);
  useFocusedNote(place, setActive);

  const lit = active == null ? null : noteRows(rows, range.side, notes[active]!);
  // Once the band hangs under the lit lines, they and the band come into view.
  useEffect(() => {
    if (!lit) return;
    const first = rowSpot(rows[lit[0]]!);
    const frame = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const host = figure.current?.querySelector('diffs-container');
        const row = host?.shadowRoot?.querySelector(lineSelector(first));
        const band = figure.current?.querySelector('.tour-walk-note');
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
    ({ metadata }: { metadata: number }) => <NoteBand note={notes[metadata]!} number={metadata + 1} />,
    [notes],
  );
  const onLineNumberClick = useCallback(
    (spot: { side: 'deletions' | 'additions'; lineNumber: number }) => {
      const found = noteAt(rows, range.side, notes, spot);
      if (found != null) setActive((at) => (at === found ? null : found));
    },
    [rows, range.side, notes],
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
        {shown.state === 'ready' && <Stepper notes={notes} active={active} setActive={setActive} step={step} />}
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

/** The walk's notes by number, between a step back and a step on; the taken one filled. */
function Stepper({
  notes,
  active,
  setActive,
  step,
}: {
  notes: readonly WalkNote[];
  active: number | null;
  setActive: (at: number | null) => void;
  step: (by: 1 | -1) => void;
}) {
  const arrow =
    'grid size-5 cursor-pointer place-items-center rounded-sm border-0 bg-transparent p-0 text-muted hover:bg-hover disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent';
  return (
    <div role="group" aria-label="Notes" className="flex shrink-0 items-center gap-0.5">
      <button
        type="button"
        className={arrow}
        disabled={active == null}
        onClick={() => step(-1)}
        title="Previous note (h)"
      >
        <ChevronLeft size="0.875rem" />
      </button>
      {notes.map((note, i) => (
        <button
          key={i}
          type="button"
          className="tour-walk-step"
          aria-pressed={i === active}
          aria-label={`Note ${i + 1}: ${note.title}`}
          title={note.title}
          onClick={() => setActive(i === active ? null : i)}
        >
          {i + 1}
        </button>
      ))}
      <button
        type="button"
        className={arrow}
        disabled={active === notes.length - 1}
        onClick={() => step(1)}
        title="Next note (l)"
      >
        <ChevronRight size="0.875rem" />
      </button>
    </div>
  );
}

/** The taken note's text, a band under its last lit line: its number, its title, its sentence. */
function NoteBand({ note, number }: { note: WalkNote; number: number }) {
  return (
    <div {...note.place} className="tour-walk-note">
      <span data-opaque="" className="tour-walk-number" aria-hidden>
        {number}
      </span>
      <div className="min-w-0">
        <div className="tour-walk-title">{note.title}</div>
        <div>{note.content}</div>
      </div>
    </div>
  );
}

/** Takes the note a focused thread is on, so its words show beside the thread's card. */
function useFocusedNote(place: Place, setActive: (at: number) => void): void {
  const walk = place['data-node'];
  const note = useStore((s) => {
    const thread = s.focusedThread == null ? undefined : s.threads.find((t) => t.id === s.focusedThread);
    if (thread?.anchor.kind !== 'tour') return null;
    const node = thread.anchor.node.join('.');
    return node.startsWith(`${walk}.`) ? Number(node.slice(walk.length + 1).split('.')[0]) : null;
  });
  useEffect(() => {
    if (note != null) setActive(note);
  }, [note, setActive]);
}
