import { useEffect, useState } from 'react';
import { FilePath } from '@/client/FilePath.js';
import { useStore } from '@/client/store.js';
import type { LineRange } from '@/client/tour/document.js';
import { rangePatch } from '@/client/tour/state.js';
import { TourJump } from './Jump.js';
import { Rows } from './Rows.js';

/** What an excerpt shows: its patch once cut, or why it shows none. */
export type Shown =
  | { state: 'loading' }
  | { state: 'gone' }
  | { state: 'error'; message: string }
  | { state: 'ready'; patch: string };

/**
 * The lines `range` names and `context` lines around them, cut from the review's diff, again
 * whenever the review moves.
 */
export function useExcerpt(range: LineRange, context = 0): Shown {
  const { path, side, start, end } = range;
  const version = useStore((s) => s.snapshot?.version);
  const [shown, setShown] = useState<Shown>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    rangePatch({ path, side, start, end }, context).then(
      (patch) => live && setShown(patch == null ? { state: 'gone' } : { state: 'ready', patch }),
      (e: unknown) => live && setShown({ state: 'error', message: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [path, side, start, end, context, version]);
  return shown;
}

/** `start-end`, or one line alone, as a range's header shows it. */
export function linesLabel({ start, end }: LineRange): string {
  return start === end ? `${start}` : `${start}-${end}`;
}

/** What stands in for an excerpt's rows while they load, or once they are gone. */
export function ExcerptNotice({ shown, range }: { shown: Exclude<Shown, { state: 'ready' }>; range: LineRange }) {
  return (
    <p className={`m-0 px-2.5 py-2 text-[0.75rem] ${shown.state === 'loading' ? 'text-muted' : 'text-warn'}`}>
      {shown.state === 'loading'
        ? 'Loading…'
        : shown.state === 'error'
          ? `Cannot show these lines: ${shown.message}`
          : `${range.start === range.end ? `Line ${range.start} is` : `Lines ${linesLabel(range)} are`} no longer in the review; ask the agent for a fresh tour.`}
    </p>
  );
}

/**
 * The lines `range` names, cut from the review's diff when the card renders and highlighted like it.
 * When they left the review, a notice stands in their place and the jump still opens the file.
 */
export function TourDiff({ range }: { range: LineRange }) {
  const shown = useExcerpt(range);
  return (
    <figure className="tour-block mx-0 overflow-hidden rounded-md border border-border bg-canvas">
      <figcaption className="flex items-center gap-1.5 border-b border-border bg-surface px-2 py-1 text-[0.75rem]">
        <FilePath path={range.path} className="min-w-0 flex-1" nowrap />
        <span className="shrink-0 font-mono text-muted">
          {range.side === 'old' ? 'before ' : ''}
          {linesLabel(range)}
        </span>
        <TourJump path={range.path} line={range.start} side={range.side} label="Open" placed />
      </figcaption>
      {shown.state === 'ready' ? <Rows patch={shown.patch} /> : <ExcerptNotice shown={shown} range={range} />}
    </figure>
  );
}
