import { History, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { twMerge } from 'tailwind-merge';
import { type Iteration, type Snapshot, shownIterations } from '../../shared/protocol.js';
import { iterationPick, relativeTime } from '../model.js';
import { useStore } from '../store.js';
import { useConfirm } from '../useConfirm.js';
import { CopyHash } from './CommitNavigator.js';
import { Button } from '../ui/Button.js';
import { ButtonLabel } from '../ui/ButtonLabel.js';

/**
 * The recorded iterations of the range, newest first; the newest is where the review stands. The
 * list is the control: a click compares that iteration with the latest; once a span is shown, a
 * plain click sets its lower number and a shift-click its higher one. A bracket marks the two
 * compared. Shown once there is something to compare; each row's
 * hash copies that iteration's head.
 */
export function IterationList({ snapshot }: { snapshot: Snapshot }) {
  const compareIterations = useStore((s) => s.compareIterations);
  const clearIterations = useStore((s) => s.clearIterations);
  const forget = useConfirm(() => void clearIterations());
  const [open, setOpen] = useState(true);
  const { iterations, mode } = snapshot;
  const latest = iterations.at(-1);
  if (!latest || iterations.length < 2) return null;
  const shown = shownIterations(mode);
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
      <div className="flex min-h-10 flex-none items-center gap-1.5 pr-1.5">
        <Button
          variant="ghost"
          className="min-w-0 flex-1 gap-1.5 self-stretch rounded-none px-2.5 py-1.5 text-left font-semibold outline-none focus-visible:bg-hover"
          aria-expanded={open}
          title={open ? 'Collapse the iterations' : 'Expand the iterations'}
          onClick={() => setOpen(!open)}
        >
          <History size="0.9375rem" /> Iterations
          <span className="rounded-[0.625rem] bg-hover px-1.75 py-0 font-medium text-muted">{iterations.length}</span>
        </Button>
        <Button
          variant="ghost"
          danger
          feedback={forget.armed ? 'confirm' : undefined}
          className="gap-1 px-1.5 py-px text-[0.75rem] leading-[1.2] font-normal"
          title={forget.armed ? 'Click again to forget them' : 'Forget the recorded iterations of this range'}
          onClick={forget.fire}
        >
          <Trash2 size="0.875rem" />
          <ButtonLabel text={forget.armed && 'Forget all?'} />
        </Button>
      </div>
      {open && (
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
              <IterationRow
                key={it.n}
                iteration={it}
                notes={notes}
                from={isFrom}
                to={isTo}
                inside={inside}
                latest={it.n === latest.n}
                title={title(it.n)}
                onPick={(shift) => pick(it.n, shift)}
              />
            );
          })}
        </ol>
      )}
    </section>
  );
}

/** One iteration; its delete button shows on hover, as a thread's does. The latest cannot go: it is the current state. */
function IterationRow({
  iteration: it,
  notes,
  from,
  to,
  inside,
  latest,
  title,
  onPick,
}: {
  iteration: Iteration;
  notes: string[];
  from: boolean;
  to: boolean;
  inside: boolean;
  latest: boolean;
  title: string;
  onPick(shift: boolean): void;
}) {
  const deleteIteration = useStore((s) => s.deleteIteration);
  const del = useConfirm(() => void deleteIteration(it.n));
  return (
    <li
      aria-current={from ? 'true' : undefined}
      className={twMerge(
        'group/iteration relative flex items-center pr-1.5',
        (from || to) && 'bg-accent/12',
        // The bracket: a bar down the compared span, with its ends on the two rows.
        (from || to || inside) && 'shadow-[inset_2px_0_0_var(--accent)]',
      )}
    >
      <Button
        variant="ghost"
        className="min-w-0 flex-1 rounded-none py-1 pr-1 pl-2.5 text-left outline-none hover:bg-transparent focus-visible:bg-hover"
        title={title}
        onClick={(e) => onPick(e.shiftKey)}
      >
        <Row iteration={it} notes={notes} emphasis={from || to} />
      </Button>
      <CopyHash commit={{ sha: it.newSha, short: it.newSha.slice(0, 7) }} />
      {/* The latest keeps the slot but no button, so the hashes line up down the list. */}
      <Button
        variant="ghost"
        danger
        icon={!del.armed}
        feedback={del.armed ? 'confirm' : undefined}
        disabled={latest}
        tabIndex={latest ? -1 : undefined}
        aria-hidden={latest || undefined}
        className={twMerge(
          'px-0.75 py-[1px] text-[0.75rem] leading-[1.2] font-normal opacity-0 group-focus-within/iteration:opacity-100 group-hover/iteration:opacity-100 data-[feedback=confirm]:opacity-100',
          latest && 'invisible',
        )}
        title={del.armed ? `Click again to forget #${it.n}` : `Forget iteration #${it.n}`}
        aria-label={del.armed ? `Forget iteration #${it.n}? Click again to confirm` : `Forget iteration #${it.n}`}
        onClick={del.fire}
      >
        <Trash2 size="0.75rem" />
        <ButtonLabel text={del.armed && 'Forget?'} />
      </Button>
    </li>
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
