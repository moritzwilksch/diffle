import { RefreshCw } from 'lucide-react';
import { movedLabel } from '../model.js';
import { useStore } from '../store.js';
import { Button } from '../ui/Button.js';

/**
 * A refs-live comparison is not swapped out under the reviewer: once its refs move, this names
 * which end moved and where to, and Reload recomputes the review there, keeping the mode and
 * the viewed marks.
 */
export function MovedNotice() {
  const snapshot = useStore((s) => s.snapshot);
  const moved = useStore((s) => s.moved);
  const reload = useStore((s) => s.reload);
  if (!snapshot || !moved) return null;
  return (
    <span
      role="status"
      className="inline-flex min-w-0 items-center gap-2 rounded-md border border-border bg-hover py-0.5 pr-0.5 pl-2 text-[0.8125rem]"
    >
      <span className="truncate font-mono text-[0.75rem]">{movedLabel(snapshot, moved)}</span>
      <Button variant="primary" onClick={() => void reload()} title="Recompute the review where the refs point now">
        <RefreshCw size="0.875rem" /> Reload
      </Button>
    </span>
  );
}
