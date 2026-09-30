import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useStore } from '../store.js';
import { Button } from '../ui/Button.js';

/**
 * Previous / next commit in a single-commit view, the mouse's share of < / >. Next walks
 * toward HEAD along its first-parent line, so it is greyed out at HEAD and off that line.
 */
export function CommitStepper() {
  const commit = useStore((s) => s.snapshot?.commit);
  const step = useStore((s) => s.stepCommit);
  if (!commit) return null;
  return (
    <span className="inline-flex items-center gap-0.5">
      <Button
        variant="ghost"
        icon
        disabled={!commit.parent}
        onClick={() => step(-1)}
        title="Previous commit (<)"
        aria-label="Previous commit"
      >
        <ChevronLeft size="1rem" />
      </Button>
      <Button
        variant="ghost"
        icon
        disabled={!commit.child}
        onClick={() => step(1)}
        title="Next commit toward HEAD (>)"
        aria-label="Next commit"
      >
        <ChevronRight size="1rem" />
      </Button>
    </span>
  );
}
