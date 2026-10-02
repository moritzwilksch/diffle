import { History } from 'lucide-react';
import { twMerge } from 'tailwind-merge';
import type { Iteration, Snapshot } from '../../shared/protocol.js';
import { relativeTime } from '../model.js';
import { useStore } from '../store.js';
import { CopyHash } from './CommitNavigator.js';
import { Button } from '../ui/Button.js';

/**
 * The recorded iterations of the range, newest first. The newest is where the review stands;
 * picking an older one shows what the branch changed since then, a rebase in between left out.
 * Shown once there is something to compare. Each row's hash copies the iteration's head.
 */
export function IterationList({ snapshot }: { snapshot: Snapshot }) {
  const compareIterations = useStore((s) => s.compareIterations);
  const { iterations, mode } = snapshot;
  const latest = iterations.at(-1);
  if (!latest || iterations.length < 2) return null;
  const from = mode.interdiff?.to.n === latest.n ? mode.interdiff.from.n : null;
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
        {iterations.toReversed().map((it) => (
          <li
            key={it.n}
            aria-current={it.n === from ? 'true' : undefined}
            className={twMerge(
              'flex items-center pr-1.5',
              it.n === from && 'bg-accent/12 shadow-[inset_2px_0_0_var(--accent)]',
            )}
          >
            {it.n === latest.n ? (
              <Row iteration={it} note="latest" className="px-2.5 py-1" />
            ) : (
              <Button
                variant="ghost"
                className="min-w-0 flex-1 rounded-none py-1 pr-1 pl-2.5 text-left outline-none hover:bg-transparent focus-visible:bg-hover"
                title={`What #${latest.n} changed since #${it.n}`}
                onClick={() => compareIterations(it.n, latest.n)}
              >
                <Row iteration={it} note={it.n === from ? `compared with #${latest.n}` : undefined} />
              </Button>
            )}
            <CopyHash commit={{ sha: it.newSha, short: it.newSha.slice(0, 7) }} />
          </li>
        ))}
      </ol>
    </section>
  );
}

function Row({ iteration, note, className }: { iteration: Iteration; note?: string; className?: string }) {
  return (
    <span className={twMerge('flex w-full items-baseline gap-2 leading-[1.125rem]', className)}>
      <span className="flex-none font-semibold">#{iteration.n}</span>
      <span className="min-w-0 flex-1 truncate text-muted">{relativeTime(iteration.recordedAt)}</span>
      {note && <span className="flex-none text-[0.75rem] text-muted">{note}</span>}
    </span>
  );
}
