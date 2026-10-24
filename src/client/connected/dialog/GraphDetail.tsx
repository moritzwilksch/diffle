import { Button } from '@/client/ui/Button.js';
import { GRAPH_HOW_TO, arrowSentence, plural } from '@/client/connected/clusters/copy.js';
import { STATUS, kindGlyph } from '@/client/connected/graph/glyphs.js';
import { LinkList, Links, type LinkRow } from './LinkList.js';
import type { GraphLayout, PlacedNode } from '@/client/connected/graph/layout.js';
import type { Selection } from '@/client/connected/graph/view.js';

/** Links named in the overview; the rest are in the graph. */
export const STRONGEST_SHOWN = 5;

export type { LinkRow };

export type Detail =
  | { kind: 'overview'; strongest: LinkRow[] }
  | { kind: 'node'; node: PlacedNode; uses: LinkRow[]; usedBy: LinkRow[] }
  | { kind: 'edge'; link: LinkRow };

const byStrength = (a: LinkRow, b: LinkRow): number =>
  b.edge.weight - a.edge.weight || (a.edge.id < b.edge.id ? -1 : a.edge.id > b.edge.id ? 1 : 0);

/** A node's list: the files at the far end, sources before tests, each group strongest first. */
const sourcesFirst =
  (far: 'from' | 'to') =>
  (a: LinkRow, b: LinkRow): number =>
    Number(a[far].test) - Number(b[far].test) || byStrength(a, b);

/** `sel` while the layout still holds it, else null: a toggled `+ context` can remove what was selected. */
export function keepSelection(layout: GraphLayout, sel: Selection): Selection {
  if (!sel) return null;
  const held =
    sel.kind === 'node' ? layout.nodes.some((n) => n.id === sel.id) : layout.edges.some((e) => e.id === sel.id);
  return held ? sel : null;
}

/** What the side panel shows: the strongest arrows, one file with its arrows (sources first), or one arrow. */
export function detailOf(layout: GraphLayout, sel: Selection): Detail {
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  const rows = layout.edges.flatMap((edge): LinkRow[] => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    return from && to ? [{ edge, from, to }] : [];
  });
  const kept = keepSelection(layout, sel);
  if (kept?.kind === 'node') {
    const node = byId.get(kept.id)!;
    return {
      kind: 'node',
      node,
      uses: rows.filter((r) => r.from.id === node.id).sort(sourcesFirst('to')),
      usedBy: rows.filter((r) => r.to.id === node.id).sort(sourcesFirst('from')),
    };
  }
  const link = kept && rows.find((r) => r.edge.id === kept.id);
  if (link) return { kind: 'edge', link };
  return { kind: 'overview', strongest: rows.sort(byStrength).slice(0, STRONGEST_SHOWN) };
}

/** The line a screen reader hears when the selection changes; empty for none. */
export function announcement(layout: GraphLayout, sel: Selection): string {
  const detail = detailOf(layout, sel);
  if (detail.kind === 'node')
    return `${detail.node.name} selected: uses ${plural(detail.uses.length, 'file')}, used by ${plural(detail.usedBy.length, 'file')}`;
  if (detail.kind === 'edge') return `Selected arrow: ${arrowSentence(detail.link.edge)}`;
  return '';
}

/** The overview's worked example: its strongest arrow in words; null when there is none. */
export function exampleOf(strongest: readonly LinkRow[]): string | null {
  const first = strongest[0];
  return first ? `Example: ${arrowSentence(first.edge)}` : null;
}

function Heading({ children }: { children: string }) {
  return <h4 className="m-0 mb-1 text-[0.75rem] font-semibold text-muted">{children}</h4>;
}

function Overview({ strongest, onSelect }: { strongest: LinkRow[]; onSelect(sel: Selection): void }) {
  const example = exampleOf(strongest);
  return (
    <>
      <section aria-label="How to read it">
        <Heading>How to read it</Heading>
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-muted">
          {GRAPH_HOW_TO.map((line) => (
            <li key={line}>{line}</li>
          ))}
          {example && <li className="text-foreground">{example}</li>}
        </ul>
      </section>
      {strongest.length > 0 && (
        <section aria-label="Strongest links">
          <Heading>Strongest links</Heading>
          <LinkList rows={strongest} far="both" onSelect={onSelect} />
        </section>
      )}
    </>
  );
}

function NodeDetail({
  detail,
  onSelect,
  onOpen,
}: {
  detail: Extract<Detail, { kind: 'node' }>;
  onSelect(sel: Selection): void;
  onOpen(path: string): void;
}) {
  const { node } = detail;
  const status = STATUS[node.status];
  return (
    <>
      <div>
        <div className={`flex items-center gap-1.5 text-[0.75rem] font-medium ${status.text}`}>
          <status.Icon size={13} aria-hidden />
          {status.label}
        </div>
        <h3 className="m-0 mt-1 text-[0.9375rem] break-all">{node.name}</h3>
        {node.dir && <p className="m-0 break-all text-muted">{node.dir}</p>}
        {node.status !== 'context' && (
          <p className="m-0 mt-1 font-mono">
            <span className="text-add">+{node.add}</span> <span className="text-del">-{node.del}</span>
          </p>
        )}
      </div>
      <Button type="button" variant="primary" className="self-start" onClick={() => onOpen(node.id)}>
        Open in review
      </Button>
      <Links title="Uses" rows={detail.uses} far="to" onSelect={onSelect} />
      <Links title="Used by" rows={detail.usedBy} far="from" onSelect={onSelect} />
    </>
  );
}

function EdgeDetail({ link, onOpen }: { link: LinkRow; onOpen(path: string): void }) {
  const { edge, from, to } = link;
  const more = edge.total - edge.uses.length;
  return (
    <>
      <div>
        <h3 className="m-0 text-[0.9375rem] leading-snug break-words">{arrowSentence(edge)}</h3>
        {edge.context && <p className="m-0 mt-1 text-muted">{from.name} is an unchanged caller.</p>}
      </div>
      <section aria-label="Symbols">
        <Heading>{`Symbols (${edge.total})`}</Heading>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {edge.uses.map((u) => {
            const kind = kindGlyph(u.kind);
            return (
              <li key={`${u.path}:${u.symbol}`} className="flex flex-wrap items-baseline gap-x-1.5">
                <kind.Icon size={13} aria-hidden className={`flex-none self-center ${kind.text}`} />
                <span className="font-mono font-medium break-all">{u.symbol}</span>
                <span className="text-muted">{kind.label}</span>
                {u.lines.length > 0 && <span className="w-full pl-5 text-muted">lines {u.lines.join(', ')}</span>}
              </li>
            );
          })}
          {more > 0 && <li className="text-muted">+{more} more</li>}
        </ul>
      </section>
      <div className="flex flex-wrap gap-1.5">
        <Button type="button" onClick={() => onOpen(from.id)}>{`Open ${from.name}`}</Button>
        <Button type="button" onClick={() => onOpen(to.id)}>{`Open ${to.name}`}</Button>
      </div>
    </>
  );
}

export interface GraphDetailProps {
  layout: GraphLayout;
  selected: Selection;
  onSelect(sel: Selection): void;
  onOpen(path: string): void;
}

/** The side panel: how to read the graph, or the selected file's or arrow's symbols; it reveals on each change. */
export function GraphDetail({ layout, selected, onSelect, onOpen }: GraphDetailProps) {
  const detail = detailOf(layout, selected);
  const key = detail.kind === 'overview' ? 'overview' : `${detail.kind}:${selected?.id}`;
  return (
    <aside
      aria-label="Details"
      className="min-h-0 w-full flex-none overflow-x-hidden overflow-y-auto p-3.5 text-[0.8125rem] @4xl:w-80 @4xl:border-l @4xl:border-l-border"
    >
      {/* Keyed on the selection, so each one plays the reveal again. */}
      <div key={key} data-motion="panel" className="flex flex-col gap-3.5">
        {detail.kind === 'overview' && <Overview strongest={detail.strongest} onSelect={onSelect} />}
        {detail.kind === 'node' && <NodeDetail detail={detail} onSelect={onSelect} onOpen={onOpen} />}
        {detail.kind === 'edge' && <EdgeDetail link={detail.link} onOpen={onOpen} />}
      </div>
    </aside>
  );
}
