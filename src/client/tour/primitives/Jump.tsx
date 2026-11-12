import { CornerDownRight } from 'lucide-react';
import type { Side } from '@/shared/side.js';
import { useHost } from '@/client/tour/host/host.js';

/**
 * A button into the diff view at `path`, on `line` of `side` when given. Its tip names the place
 * unless the label or, with `placed`, the text beside it already shows it.
 */
export function TourJump({
  path,
  line,
  side,
  label,
  placed = false,
}: {
  path: string;
  line?: number;
  side: Side;
  label: string;
  placed?: boolean;
}) {
  const { open } = useHost();
  const where = line == null ? path : `${path}:${line}${side === 'old' ? ' (before)' : ''}`;
  return (
    <button
      type="button"
      className="mx-0.5 inline-flex cursor-pointer items-center gap-1 rounded-sm border border-border bg-surface px-1.5 py-px align-baseline font-sans text-[0.75rem] text-accent hover:bg-hover"
      onClick={() => open(path, line, side)}
      title={placed || label === where ? undefined : `Open ${where} in the diff`}
    >
      <CornerDownRight size="0.75rem" />
      {label}
    </button>
  );
}
