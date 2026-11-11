import { ChevronRight, Eye, Link2, type LucideIcon } from 'lucide-react';
import { type ComponentProps, useEffect, useMemo } from 'react';
import { twMerge } from 'tailwind-merge';
import type { GraphEdge, GraphNode } from '@/shared/protocol.js';
import { canvasControl } from '@/client/graph/GraphCanvas.js';
import type { PlacedNode } from '@/client/graph/layout/layout.js';
import { bySource } from '@/client/graph/layout/order.js';
import { edgeKey } from '@/client/graph/layout/rank.js';
import { useGraph } from '@/client/graph/state.js';
import { useStore } from '@/client/store.js';
import { Button } from '@/client/ui/Button.js';
import { Code, ENTRY, JumpChip, Jumps, META, Name, SectionHeading } from './GraphDetailParts.js';
import type { PeekEntry } from './peekLinks.js';
import type { Signatures } from './useSignatures.js';

/** The symbols a file arrow's reference lines use, by line. */
export type UsedAt = Map<number, GraphNode[]>;

/** A plain button that reads as a link, without the browser's button chrome. */
function LinkButton({ className, ...props }: ComponentProps<'button'>) {
  return (
    <button
      type="button"
      {...props}
      className={twMerge('cursor-pointer border-0 bg-transparent p-0 text-left hover:underline', className)}
    />
  );
}

/**
 * The nodes at the other end of `edges`: each selects itself in the graph by its name, and opens
 * the diff where it is defined and where the link sits. In the graph's reading order, so the
 * cards run as their boxes do.
 */
export function Links({
  icon,
  title,
  edges,
  other,
  site,
  used,
  signatures,
  onPeek,
}: {
  icon: LucideIcon;
  title: string;
  edges: GraphEdge[];
  other: (e: GraphEdge) => GraphNode | undefined;
  /** The file holding the references, given the other end. */
  site: (other: GraphNode) => string;
  /** File view only: the symbols each reference line uses. */
  used?: (e: GraphEdge) => UsedAt;
  signatures: Signatures;
  /** Lists every entry's lines in the references overlay. */
  onPeek: (entries: PeekEntry[]) => void;
}) {
  // A card removed under the pointer never sees it leave, so its hover would outlive it and keep
  // lighting a box once the panel shows another node (Ctrl+o back from a picked link).
  useEffect(() => () => useGraph.getState().hoverEdge(null), [edges]);
  const placed = useGraph((s) => s.view?.stacked.nodes);
  const rank = useMemo(() => readingOrder(placed ?? []), [placed]);
  const rows = edges
    .map((e) => ({ e, n: other(e) }))
    .filter((r): r is { e: GraphEdge; n: GraphNode } => r.n != null)
    .sort((a, b) => (rank.get(a.n.id) ?? Infinity) - (rank.get(b.n.id) ?? Infinity) || bySource(a.n, b.n));
  if (!rows.length) return null;
  return (
    <section className="flex flex-col gap-3">
      <SectionHeading
        icon={icon}
        count={rows.length}
        action={
          <Button
            variant="ghost"
            className="-my-1 text-[0.75rem] font-normal text-muted hover:text-foreground"
            onClick={() => onPeek(rows.map(({ e, n }) => ({ node: n, path: site(n), lines: e.lines })))}
            title="Step through every line of these links in the references list, without leaving the graph"
          >
            <Eye size="0.8125rem" /> Peek
          </Button>
        }
      >
        {title}
      </SectionHeading>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {rows.map(({ e, n }) => (
          <li
            key={`${e.from}>${e.to}`}
            className={`${ENTRY} cursor-pointer`}
            // The card frames its node in the graph, as a double-click there does; its own buttons and
            // a text selection in it keep their clicks.
            onClick={(ev) => {
              if ((ev.target as Element).closest('button, a') || window.getSelection()?.toString()) return;
              jumpTo(n.id);
            }}
            onPointerEnter={() => useGraph.getState().hoverEdge(edgeKey(e))}
            onPointerLeave={() => useGraph.getState().hoverEdge(null)}
          >
            {used ? (
              // A file's card is its usages: the section names which way they run and the panel's
              // title the file at this end, so the link icon heads the card instead of a second path.
              <>
                <NodeRow node={n} icon={Link2} />
                <UsedLines path={site(n)} lines={e.lines} used={used(e)} />
              </>
            ) : (
              <>
                <NodeRow node={n} />
                <Jumps
                  rows={[
                    ...(n.kind === 1 ? [] : [{ to: 'definition' as const, path: n.path, lines: [n.line] }]),
                    { to: 'reference' as const, path: site(n), lines: e.lines },
                  ]}
                />
              </>
            )}
            <Code signature={signatures.get(n.id)} path={n.path} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Each box's place reading the graph as text: rows top to bottom, a box joining the row whose first
 * box it overlaps vertically, then left to right within a row.
 */
function readingOrder(nodes: PlacedNode[]): Map<string, number> {
  const rows: PlacedNode[][] = [];
  for (const n of [...nodes].sort((a, b) => a.y - b.y)) {
    const row = rows[rows.length - 1];
    if (row && n.y < row[0]!.y + row[0]!.h) row.push(n);
    else rows.push([n]);
  }
  return new Map(rows.flatMap((row) => row.sort((a, b) => a.x - b.x)).map((n, i) => [n.node.id, i]));
}

/** Selects and frames a linked node, a jump Ctrl+o returns from. */
function jumpTo(id: string) {
  if (id !== useGraph.getState().selected) useStore.getState().recordJump();
  canvasControl.frame(id);
}

/** A linked node's name, selecting and framing it in the graph; the chevron says the row leads there. */
function NodeRow({ node, icon }: { node: GraphNode; icon?: LucideIcon }) {
  return (
    <LinkButton
      className="group flex items-center justify-between gap-2 hover:no-underline"
      onClick={() => jumpTo(node.id)}
    >
      <span className="group-hover:underline">
        <Name node={node} icon={icon} />
      </span>
      <ChevronRight size="0.875rem" className="shrink-0 text-muted" />
    </LinkButton>
  );
}

/** A file arrow's reference lines in `path`: a chip per line, each beside the symbols its line uses. */
function UsedLines({ path, lines, used }: { path: string; lines: number[]; used: UsedAt }) {
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${META}`}>
      {[...lines]
        .sort((a, b) => a - b)
        .map((line) => (
          <span key={line} className="flex min-w-0 items-center gap-2">
            {/* A column as wide as a four-digit chip, so the names line up. */}
            <span className="w-14 shrink-0">
              <JumpChip path={path} line={line} />
            </span>
            <span className="flex min-w-0 flex-wrap gap-x-2 text-foreground">
              {(used.get(line) ?? []).map((n) => (
                <Name key={n.id} node={n} className="text-[0.75rem]" />
              ))}
            </span>
          </span>
        ))}
    </div>
  );
}
