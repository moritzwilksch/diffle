import { FileCode2, Pencil, Plus } from 'lucide-react';
import { kindGroup, KindIcon } from '@/client/lsp/symbolKind.js';
import type { GraphNode } from '@/shared/protocol.js';
import { basename, clip, dirname, nodeLabel } from './labels.js';
import { CLUSTER_HEADER, type PlacedCluster, type PlacedNode } from '@/client/graph/layout/layout.js';

const STATUS_STROKE: Record<GraphNode['status'], string> = {
  added: 'var(--add)',
  modified: 'var(--accent)',
  consumer: 'var(--border)',
};

const KIND_COLOR: Record<string, string> = {
  type: 'var(--kind-type)',
  callable: 'var(--kind-callable)',
  value: 'var(--kind-value)',
};

// Monospace character widths at the sizes below, to clip text to its box.
const HEADER_CHAR = 6.9;
const TITLE_CHAR = 7.3;
const DETAIL_CHAR = 6.1;

/** A file's box in one column: the file icon and its path as everywhere in diffle, dim directories and a bold name. */
export function Cluster({
  cluster,
  members,
  opacity,
}: {
  cluster: PlacedCluster;
  members: PlacedNode[];
  opacity: number;
}) {
  const unchanged = members.every((n) => n.node.status === 'consumer');
  const room = Math.floor((cluster.w - 34) / HEADER_CHAR);
  const name = clip(basename(cluster.path), room);
  const dir = dirname(cluster.path);
  // The directory gives way first, from its start, so the nearest folders stay.
  const dirRoom = room - name.length - 1;
  const shownDir = !dir || dirRoom < 4 ? '' : dir.length + 1 > dirRoom ? `…${dir.slice(-(dirRoom - 2))}/` : `${dir}/`;
  return (
    <g opacity={opacity}>
      {`${shownDir}${name}` !== cluster.path && <title>{cluster.path}</title>}
      <rect
        x={cluster.x}
        y={cluster.y}
        width={cluster.w}
        height={cluster.h}
        rx={9}
        // A changed file is a tinted area under its symbol cards, no border; an unchanged one only
        // users live in keeps the dashed outline that marks users.
        fill={unchanged ? 'transparent' : 'color-mix(in srgb, var(--fg) 6%, var(--bg))'}
        stroke={unchanged ? 'var(--border)' : 'none'}
        strokeDasharray={unchanged ? '5 4' : undefined}
      />
      <FileCode2 x={cluster.x + 9} y={cluster.y + 7} size={13} color="var(--fg-2)" />
      <text x={cluster.x + 27} y={cluster.y + CLUSTER_HEADER / 2 + 4} className="font-mono text-[11.5px]">
        {shownDir && <tspan className="fill-muted">{shownDir}</tspan>}
        <tspan className={unchanged ? 'fill-muted' : 'fill-foreground'} fontWeight={600}>
          {name}
        </tspan>
      </text>
    </g>
  );
}

const STATUS_BADGE: Partial<Record<GraphNode['status'], { icon: typeof Plus; color: string }>> = {
  added: { icon: Plus, color: 'var(--add)' },
  modified: { icon: Pencil, color: 'var(--accent)' },
};

/**
 * A symbol: its kind's icon and colour, its name in monospace, what it is under it, and its change
 * as a badge (an icon besides the colour). A test recedes: quieter fill and name, and a `test` tag.
 */
export function Node({
  placed,
  clustered,
  selected,
  opacity,
  test,
}: {
  placed: PlacedNode;
  clustered: boolean;
  selected: boolean;
  opacity: number;
  test: boolean;
}) {
  const { node, x, y, w, h } = placed;
  const { title, detail } = nodeLabel(node, clustered);
  const quiet = node.status === 'consumer' || test;
  const badge = STATUS_BADGE[node.status];
  return (
    <g data-node={node.id} opacity={opacity} className="cursor-pointer">
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={6}
        // The selection takes the box itself, an accent border over a light accent fill; the badge
        // keeps the change status in view.
        fill={
          selected ? 'color-mix(in srgb, var(--accent) 12%, var(--bg-card))' : quiet ? 'var(--bg)' : 'var(--bg-card)'
        }
        stroke={
          selected ? 'var(--accent)' : test && node.status !== 'consumer' ? 'var(--border)' : STATUS_STROKE[node.status]
        }
        strokeWidth={selected ? 2.5 : quiet ? 1 : 1.5}
        strokeDasharray={node.status === 'consumer' && !clustered && !selected ? '4 3' : undefined}
      />
      <KindIcon
        kind={node.kind}
        x={x + 7}
        y={y + 7}
        size={14}
        color={KIND_COLOR[kindGroup(node.kind)] ?? 'var(--fg-2)'}
        opacity={quiet ? 0.6 : 1}
      />
      <text x={x + 26} y={y + 18} className={`font-mono text-[12px] ${quiet ? 'fill-muted' : 'fill-foreground'}`}>
        {clip(title, Math.floor((w - 56) / TITLE_CHAR))}
      </text>
      <text x={x + 26} y={y + 32} className="fill-muted font-sans text-[10.5px]">
        {test && <tspan className="fill-foreground font-semibold">test · </tspan>}
        {clip(detail, Math.floor((w - 34) / DETAIL_CHAR))}
      </text>
      {badge && (
        <g>
          <rect
            x={x + w - 22}
            y={y + 5}
            width={16}
            height={16}
            rx={4}
            fill={`color-mix(in srgb, ${badge.color} 15%, transparent)`}
          />
          <badge.icon x={x + w - 19} y={y + 8} size={10} color={badge.color} strokeWidth={2.5} />
        </g>
      )}
    </g>
  );
}

/** Stroke widths an arrow is drawn in; each has its own head, sized to it. */
export const ARROW_WIDTHS = [1, 2, 3] as const;

/** The arrowhead for a stroke of `width`, muted or lit. */
export const arrowHead = (width: number, lit: boolean) => `url(#graph-arrow-${width}${lit ? '-lit' : ''})`;

/** Arrowheads in user units, so a head keeps to its line's weight instead of growing with it. */
export function ArrowDefs() {
  return (
    <defs>
      {ARROW_WIDTHS.flatMap((w) =>
        [false, true].map((lit) => {
          const size = 5 + 2.5 * w;
          return (
            <marker
              key={`${w}${lit}`}
              id={`graph-arrow-${w}${lit ? '-lit' : ''}`}
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerUnits="userSpaceOnUse"
              markerWidth={size}
              markerHeight={size}
              orient="auto"
            >
              <path d="M0,0.5 L7.5,4 L0,7.5 z" fill={lit ? 'var(--accent)' : 'var(--fg-2)'} />
            </marker>
          );
        }),
      )}
    </defs>
  );
}
