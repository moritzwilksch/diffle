import { ArrowLeft, ArrowRight } from 'lucide-react';
import { canJumpBack, canJumpForward } from '../model.js';
import { useStore } from '../store.js';
import { Button } from '../ui/Button.js';

/**
 * Back and forward through the jump list, the mouse's share of Ctrl+o / Ctrl+i. Always in place
 * and greyed out where the walk has nowhere to go. The wording is neutral because a jump can lead
 * to a diff, a whole file, or a file outside the repository.
 */
export function HistoryNav() {
  const back = useStore(canJumpBack);
  const forward = useStore(canJumpForward);
  const jumpBack = useStore((s) => s.jumpBack);
  const jumpForward = useStore((s) => s.jumpForward);
  return (
    <span className="inline-flex items-center gap-0.5">
      <Button variant="ghost" icon disabled={!back} onClick={jumpBack} title="Back (Ctrl+o)" aria-label="Back">
        <ArrowLeft size="1rem" />
      </Button>
      <Button
        variant="ghost"
        icon
        disabled={!forward}
        onClick={jumpForward}
        title="Forward (Ctrl+i)"
        aria-label="Forward"
      >
        <ArrowRight size="1rem" />
      </Button>
    </span>
  );
}
