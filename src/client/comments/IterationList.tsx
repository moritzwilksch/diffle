import { History } from 'lucide-react';
import { twMerge } from 'tailwind-merge';
import type { Iteration, Snapshot } from '../../shared/protocol.js';
import { iterationPick, relativeTime } from '../model.js';
import { useStore } from '../store.js';
import { CopyHash } from './CommitNavigator.js';
import { Button } from '../ui/Button.js';

/**
 * The recorded iterations of the range, newest first; the newest is where the review stands. The
 * list is the control: a click compares that iteration with the latest; once a span is shown, a
 * row offers two spans, one keeping the start and one the end, and shift-click takes the second.
 * A bracket marks the two compared. Shown once there is something to compare; each row's
 * hash copies that iteration's head.
 */
export function IterationList({ snapshot }: { snapshot: Snapshot }) {
  const compareIterations = useStore((s) => s.compareIterations);
  const { iterations, mode } = snapshot;
  const latest = iterations.at(-1);
  if (!latest || iterations.length < 2) return null;
  const shown = mode.interdiff ? { from: mode.interdiff.from.n, to: mode.interdiff.to.n } : null;
  const pick = (n: number, shift: boolean) => {
    const next = iterationPick(shown, latest.n, n, shift);
    if (next) compareIterations(next.from, next.to);
  };
  // One line per gesture, each naming what it would show; a gesture that changes nothing is left out.
  const title = (n: number) => {
    const lines = [false, true].flatMap((shift) => {
      const next = iterationPick(shown, latest.n, n, shift);
      return next ? [`Compare #${next.from} with #${next.to}${shift ? ' (shift-click)' : ''}`] : [];
    });
    return lines.length ? lines.join('\n') : 'Compared now';
  };
  return (
    <section
      className="flex max-h-[30%] shrink-0 flex-col border-b border-b-border text-[0.8125rem]"
      aria-label="Iterations"
    >
      <div className="flex min-h-10 flex-none items-center gap-1.5 px-2.5 py-1.5 font-semibold">
        <History size="0.9375rem" /> Iterations
        <span className="rounded-[0.625rem] bg-hover px-1.75 py-0 font-medium text-muted">{iterations.length}</span>
      </div>
      <ol className="m-0 min-h-0 list-none overflow-auto p-0 pb-1.5">
        {iterations.toReversed().map((it) => {
          const isFrom = shown?.from === it.n;
          const isTo = shown?.to === it.n;
          const inside = shown != null && shown.from < it.n && it.n < shown.to;
          const notes = [
            it.n === latest.n && 'latest',
            isTo && shown && `compared with #${shown.from}`,
            isFrom && 'from here',
          ].filter((n): n is string => Boolean(n));
          return (
            <li
              key={it.n}
              aria-current={isFrom ? 'true' : undefined}
              className={twMerge(
                'relative flex items-center pr-1.5',
                (isFrom || isTo) && 'bg-accent/12',
                // The bracket: a bar down the compared span, with its ends on the two rows.
                (isFrom || isTo || inside) && 'shadow-[inset_2px_0_0_var(--accent)]',
              )}
            >
              <Button
                variant="ghost"
                className="min-w-0 flex-1 rounded-none py-1 pr-1 pl-2.5 text-left outline-none hover:bg-transparent focus-visible:bg-hover"
                title={title(it.n)}
                onClick={(e) => pick(it.n, e.shiftKey)}
              >
                <Row iteration={it} notes={notes} emphasis={isFrom || isTo} />
              </Button>
              <CopyHash commit={{ sha: it.newSha, short: it.newSha.slice(0, 7) }} />
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Row({ iteration, notes, emphasis }: { iteration: Iteration; notes: string[]; emphasis: boolean }) {
  return (
    <span className="flex w-full items-baseline gap-2 leading-[1.125rem]">
      <span className={twMerge('flex-none', emphasis ? 'font-semibold' : 'font-medium')}>#{iteration.n}</span>
      <span className="min-w-0 flex-1 truncate text-muted">{relativeTime(iteration.recordedAt)}</span>
      {notes.length > 0 && <span className="flex-none text-[0.75rem] text-muted">{notes.join(' · ')}</span>}
    </span>
  );
}
