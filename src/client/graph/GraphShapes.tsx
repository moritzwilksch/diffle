import { FileCode2 } from 'lucide-react';
import { kindGroup, KindIcon } from '@/client/lsp/symbolKind.js';
import type { GraphNode } from '@/shared/protocol.js';
import { basename, clip, dirname, nodeLabel } from './labels.js';
import { CLUSTER_HEADER, type PlacedCluster, type PlacedNode } from './layout.js';

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
      <title>{cluster.path}</title>
      <rect
        x={cluster.x}
        y={cluster.y}
        width={cluster.w}
        height={cluster.h}
        rx={9}
        fill={unchanged ? 'transparent' : 'var(--bg-card)'}
        stroke="var(--border)"
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

/** A symbol: its kind's icon and colour, its name in monospace, and what it is under it. */
export function Node({
  placed,
  clustered,
  selected,
  opacity,
}: {
  placed: PlacedNode;
  clustered: boolean;
  selected: boolean;
  opacity: number;
}) {
  const { node, x, y, w, h } = placed;
  const { title, detail } = nodeLabel(node, clustered);
  const consumer = node.status === 'consumer';
  return (
    <g data-node={node.id} opacity={opacity} className="cursor-pointer">
      <title>{`${node.path}:${node.line}`}</title>
      {/* The selection ring sits outside the box, so the status border always shows. */}
      {selected && (
        <rect
          x={x - 4}
          y={y - 4}
          width={w + 8}
          height={h + 8}
          rx={9}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={2}
        />
      )}
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={6}
        fill={consumer ? 'var(--bg)' : 'var(--bg-2)'}
        stroke={STATUS_STROKE[node.status]}
        strokeWidth={consumer ? 1 : 1.5}
        strokeDasharray={consumer && !clustered ? '4 3' : undefined}
      />
      <KindIcon
        kind={node.kind}
        x={x + 7}
        y={y + 7}
        size={14}
        color={KIND_COLOR[kindGroup(node.kind)] ?? 'var(--fg-2)'}
        opacity={consumer ? 0.6 : 1}
      />
      <text x={x + 26} y={y + 18} className={`font-mono text-[12px] ${consumer ? 'fill-muted' : 'fill-foreground'}`}>
        {clip(title, Math.floor((w - 32) / TITLE_CHAR))}
      </text>
      <text x={x + 26} y={y + 32} className="fill-muted font-sans text-[10.5px]">
        {clip(detail, Math.floor((w - 32) / DETAIL_CHAR))}
      </text>
    </g>
  );
}

/** Arrowheads for the edges: muted, and lit for the selection's. */
export function ArrowDefs() {
  return (
    <defs>
      {[
        ['graph-arrow', 'var(--fg-2)'],
        ['graph-arrow-lit', 'var(--accent)'],
      ].map(([id, fill]) => (
        <marker key={id} id={id} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto">
          <path d="M0,0.5 L7.5,4 L0,7.5 z" fill={fill} />
        </marker>
      ))}
    </defs>
  );
}
