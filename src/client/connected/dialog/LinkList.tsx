import { useId, useState } from 'react';
import { ArrowRight, ChevronDown, ChevronRight, ChevronUp } from 'lucide-react';
import type { GraphUse } from '@/shared/protocol.js';
import { Button } from '@/client/ui/Button.js';
import { STATUS, kindGlyph } from '@/client/connected/graph/glyphs.js';
import type { PlacedNode, RoutedEdge } from '@/client/connected/graph/layout.js';
import { edgeTitle, type Selection } from '@/client/connected/graph/view.js';

/** Rows a list shows before one button folds the rest. */
export const LIST_CAP = 6;
/** Symbols a row names before "+N more"; the arrow's panel lists them all. */
export const CHIPS_SHOWN = 3;

/** Why a list is empty, by the end of the arrow the list is about. */
export const EMPTY_TEXT = { to: 'It uses nothing else drawn.', from: 'Nothing drawn uses it.' } as const;

/** An arrow with both of its files. */
export interface LinkRow {
  edge: RoutedEdge;
  from: PlacedNode;
  to: PlacedNode;
}

/** The symbols a row names and how many it leaves out, so the two always add up to the arrow's total. */
export function chipsOf(edge: Pick<RoutedEdge, 'uses' | 'total'>): { shown: GraphUse[]; more: number } {
  const shown = edge.uses.slice(0, CHIPS_SHOWN);
  return { shown, more: Math.max(0, edge.total - shown.length) };
}

/** The rows to draw and how many the cap folds away. */
export function visibleRows<T>(rows: readonly T[], expanded: boolean): { rows: readonly T[]; folded: number } {
  if (expanded || rows.length <= LIST_CAP) return { rows, folded: 0 };
  return { rows: rows.slice(0, LIST_CAP), folded: rows.length - LIST_CAP };
}

export const listToggleLabel = (total: number, expanded: boolean): string =>
  expanded ? 'Show fewer' : `Show all ${total}`;

/** A symbol with its kind icon and its first line; the title carries every line. */
function Chip({ use }: { use: GraphUse }) {
  const kind = kindGlyph(use.kind);
  const first = use.lines[0];
  const lines = use.lines.length > 0 ? ` lines ${use.lines.join(', ')}` : '';
  return (
    <span
      className="inline-flex max-w-full items-center gap-1 rounded-[0.3125rem] bg-hover px-1.5 py-px font-mono text-[0.75rem]"
      title={`${use.symbol} (${kind.label})${lines}`}
    >
      <kind.Icon size={12} aria-hidden className={`flex-none ${kind.text}`} />
      <span className="truncate font-medium">{use.symbol}</span>
      {/* The foreground token at regular weight: the muted one is under 4.5:1 on the chip's fill in light. */}
      {first !== undefined && <span className="flex-none font-normal tabular-nums">:{first}</span>}
    </span>
  );
}

/** The cards' "test" tag, as text: same word and tint, foreground ink so it reads at this size. */
function TestTag() {
  return (
    <span className="flex-none rounded-[0.1875rem] bg-muted/15 px-1 text-[0.625rem] leading-[1.4] font-semibold">
      test
    </span>
  );
}

function FarName({ row, far }: { row: LinkRow; far: 'from' | 'to' | 'both' }) {
  if (far !== 'both') return <span className="min-w-0 truncate">{(far === 'from' ? row.from : row.to).name}</span>;
  return (
    <span className="min-w-0 truncate">
      {row.from.name} <ArrowRight size={12} aria-hidden className="inline flex-none" /> {row.to.name}
    </span>
  );
}

/**
 * One arrow as a button that selects it: the file at the far end (status, name, test tag, directory), then the
 * symbols that link them. The chevron says it drills into the arrow.
 */
export function LinkButton({
  row,
  far,
  onSelect,
}: {
  row: LinkRow;
  far: 'from' | 'to' | 'both';
  onSelect(sel: Selection): void;
}) {
  const other = far === 'from' ? row.from : row.to;
  const status = STATUS[other.status];
  const chips = chipsOf(row.edge);
  const muted = far !== 'both' && other.test;
  return (
    <Button
      type="button"
      variant="ghost"
      className="group min-h-11 w-full items-center gap-2 px-2 py-1.5 text-left whitespace-normal focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      title={edgeTitle(row.edge)}
      onClick={() => onSelect({ kind: 'edge', id: row.edge.id })}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className={`flex items-center gap-1.5 font-medium ${muted ? 'text-muted' : ''}`}>
          {far !== 'both' && (
            <>
              <status.Icon size={14} aria-hidden className={`flex-none ${status.text}`} />
              <span className="sr-only">{status.label}: </span>
            </>
          )}
          <FarName row={row} far={far} />
          {muted && <TestTag />}
        </span>
        {far !== 'both' && other.dir && (
          // rtl cuts the start of a long path, so the folder next to the file stays in view.
          <span className="block truncate text-left text-[0.75rem] text-muted [direction:rtl]">
            <bdi>{other.dir}</bdi>
          </span>
        )}
        <span className="flex flex-wrap gap-1">
          {chips.shown.map((u) => (
            <Chip key={`${u.path}:${u.symbol}`} use={u} />
          ))}
          {chips.more > 0 && <span className="self-center text-[0.75rem] text-muted">+{chips.more} more</span>}
        </span>
      </span>
      <ChevronRight size={14} aria-hidden className="flex-none text-muted group-hover:text-foreground" />
    </Button>
  );
}

/** A list of arrows with one disclosure button once it passes the cap; the panel is keyed, so it folds again on each selection. */
export function LinkList({
  rows,
  far,
  onSelect,
}: {
  rows: readonly LinkRow[];
  far: 'from' | 'to' | 'both';
  onSelect(sel: Selection): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const { rows: shown, folded } = visibleRows(rows, expanded);
  return (
    <>
      <ul id={listId} className="m-0 flex list-none flex-col gap-3 p-0">
        {shown.map((r) => (
          <li key={r.edge.id}>
            <LinkButton row={r} far={far} onSelect={onSelect} />
          </li>
        ))}
      </ul>
      {(folded > 0 || expanded) && (
        <Button
          type="button"
          className="mt-3 min-h-11 w-full justify-center gap-1.5 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded((e) => !e)}
        >
          {listToggleLabel(rows.length, expanded)}
          {expanded ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
        </Button>
      )}
    </>
  );
}

/** One side of a selected file: "Uses" lists its far ends, "Used by" the files that call it. */
export function Links({
  title,
  rows,
  far,
  onSelect,
}: {
  title: string;
  rows: readonly LinkRow[];
  far: 'from' | 'to';
  onSelect(sel: Selection): void;
}) {
  return (
    <section aria-label={title}>
      <h4 className="m-0 mb-1 text-[0.75rem] font-semibold text-muted">{`${title} (${rows.length})`}</h4>
      {rows.length === 0 ? (
        <p className="m-0 text-muted">{EMPTY_TEXT[far]}</p>
      ) : (
        <LinkList rows={rows} far={far} onSelect={onSelect} />
      )}
    </section>
  );
}
