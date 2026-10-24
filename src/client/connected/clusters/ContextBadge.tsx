import { useMemo } from 'react';
import type { GraphContext, GraphUse } from '@/shared/protocol.js';
import { contextEntries } from '@/client/model.js';
import { useStore } from '@/client/store.js';
import { plural } from './copy.js';
import { useLines } from './focus.js';

/** Symbols named in a header before the rest fold into a count. */
const SYMBOLS_SHOWN = 3;
/** Line numbers a header names; the title and the cursor stops carry the rest. */
const LINES_SHOWN = 3;

/** `foo ×3, bar ×1 · L42, L88`: what a context file uses of its cluster, and where it starts. */
export function usesLabel(uses: readonly GraphUse[]): string {
  const symbols = uses
    .slice(0, SYMBOLS_SHOWN)
    .map((u) => (u.lines.length > 0 ? `${u.symbol} ×${u.lines.length}` : u.symbol));
  if (uses.length > SYMBOLS_SHOWN) symbols.push(`+${uses.length - SYMBOLS_SHOWN} more`);
  const lines = useLines(uses)
    .slice(0, LINES_SHOWN)
    .map((l) => `L${l}`);
  return [symbols.join(', '), lines.join(', ')].filter(Boolean).join(' · ');
}

/** The hover text of a context header: why the file is listed, in full. */
export function contextTitle(entry: GraphContext): string {
  const names = entry.uses.map((u) => u.symbol).join(', ');
  return `Not changed. Uses ${plural(entry.uses.length, 'changed symbol')} of this cluster: ${names} (${plural(entry.refs, 'reference')})`;
}

/** The mark on a context file's header, read from the graph so it shows while the file is still collapsed. */
export function ContextBadge({ path }: { path: string }) {
  const snapshot = useStore((s) => s.snapshot);
  const data = useStore((s) => s.graph.data);
  const focus = useStore((s) => s.focus);
  const context = useStore((s) => s.context);
  const entry = useMemo(
    () => contextEntries({ snapshot, graph: { data }, focus, context }).find((c) => c.path === path),
    [snapshot, data, focus, context, path],
  );
  if (!entry) return null;
  const label = usesLabel(entry.uses);
  return (
    <>
      <span
        className="inline-flex shrink-0 items-center gap-0.75 rounded-[0.625rem] bg-hover px-1.75 py-0 font-sans text-muted"
        title={contextTitle(entry)}
      >
        unchanged context
      </span>
      {label && <span className="max-w-[20rem] truncate text-muted">{label}</span>}
    </>
  );
}
