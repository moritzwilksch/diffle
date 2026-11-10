import { CornerDownRight } from 'lucide-react';
import type { Side } from '@/shared/protocol.js';
import { jump } from '@/client/tour/state.js';

/** A button into the diff view at `path`, on `line` of `side` when given. */
export function TourJump({ path, line, side, label }: { path: string; line?: number; side: Side; label: string }) {
  const where = line == null ? path : `${path}:${line}${side === 'old' ? ' (before)' : ''}`;
  return (
    <button
      type="button"
      className="mx-0.5 inline-flex cursor-pointer items-center gap-1 rounded-sm border border-border bg-surface px-1.5 py-px align-baseline font-sans text-[0.75rem] text-accent hover:bg-hover"
      // The canvas pans on a press; a press on the button is the button's.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => void jump(path, line, side)}
      title={label === where ? 'Open in the diff' : `Open ${where} in the diff`}
    >
      <CornerDownRight size="0.75rem" />
      {label}
    </button>
  );
}
