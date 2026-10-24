import { useEffect, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from 'react';
import { kindGroup } from '@/client/lsp/symbolKind.js';
import type { GraphNode } from '@/shared/protocol.js';
import { basename, clip, dirname, nodeLabel } from './labels.js';
import { CLUSTER_HEADER, type Placed, type PlacedCluster, type PlacedNode } from './layout.js';

interface View {
  x: number;
  y: number;
  k: number;
}

const MARGIN = 48;
const HEAD = 28;

const STATUS_STROKE: Record<GraphNode['status'], string> = {
  added: 'var(--add)',
  modified: 'var(--accent)',
  consumer: 'var(--border)',
};

const KIND_FILL: Record<string, string> = {
  type: 'var(--kind-type)',
  callable: 'var(--kind-callable)',
  value: 'var(--kind-value)',
};

/**
 * The placed graph as SVG, panned by dragging and zoomed by the wheel. Selecting a node keeps it,
 * its edges and its neighbours lit and fades the rest.
 */
export function GraphCanvas({
  placed,
  clustered,
  selected,
  onSelect,
}: {
  placed: Placed;
  clustered: boolean;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  // Pointer capture retargets the release to the host, so the press remembers which node it hit.
  const drag = useRef<{ x: number; y: number; moved: boolean; node: string | null } | null>(null);

  const fit = () => {
    const el = host.current;
    if (!el) return;
    const [w, h] = [placed.width + 2 * MARGIN, placed.height + 2 * MARGIN + HEAD];
    const k = Math.min(1.25, el.clientWidth / w, el.clientHeight / h);
    setView({
      k,
      x: (el.clientWidth - w * k) / 2 + MARGIN * k,
      y: (el.clientHeight - h * k) / 2 + (MARGIN + HEAD) * k,
    });
  };
  useEffect(fit, [placed]);

  const lit = useMemo(() => {
    if (!selected) return null;
    const ids = new Set([selected]);
    for (const { edge } of placed.edges)
      if (edge.from === selected || edge.to === selected) ids.add(edge.from).add(edge.to);
    return ids;
  }, [placed, selected]);

  const onWheel = (e: WheelEvent) => {
    const rect = host.current!.getBoundingClientRect();
    const [px, py] = [e.clientX - rect.left, e.clientY - rect.top];
    setView((v) => {
      const k = Math.min(3, Math.max(0.15, v.k * Math.exp(-e.deltaY * 0.0015)));
      return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
    });
  };
  const onPointerDown = (e: PointerEvent) => {
    const node = (e.target as Element).closest('[data-node]')?.getAttribute('data-node') ?? null;
    drag.current = { x: e.clientX, y: e.clientY, moved: false, node };
    host.current!.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const [dx, dy] = [e.clientX - d.x, e.clientY - d.y];
    if (!d.moved && Math.hypot(dx, dy) < 3) return;
    drag.current = { ...d, x: e.clientX, y: e.clientY, moved: true };
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved) onSelect(d.node);
  };

  const dim = (id: string) => (lit && !lit.has(id) ? 0.18 : 1);
  return (
    <div
      ref={host}
      className="relative h-full w-full cursor-grab touch-none overflow-hidden bg-canvas select-none active:cursor-grabbing"
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={fit}
    >
      <svg className="absolute inset-0 h-full w-full" role="img" aria-label="Change graph">
        <defs>
          <marker id="graph-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,0.5 L7.5,4 L0,7.5 z" fill="var(--fg-2)" />
          </marker>
          <marker
            id="graph-arrow-lit"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto"
          >
            <path d="M0,0.5 L7.5,4 L0,7.5 z" fill="var(--accent)" />
          </marker>
        </defs>
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {placed.columns.map((c, i) => (
            <text
              key={i}
              x={c.x + c.w / 2}
              y={-HEAD + 6}
              textAnchor="middle"
              className="fill-muted font-sans text-[11px]"
            >
              {i === 0 ? 'entry' : i === placed.columns.length - 1 ? 'core' : ''}
            </text>
          ))}
          {placed.shelf != null && (
            <text x={0} y={placed.shelf - 12} className="fill-muted font-sans text-[11px]">
              No links to other changes or their users
            </text>
          )}
          {placed.clusters.map((c) => (
            <Cluster key={`${c.path}@${c.column}@${c.y}`} cluster={c} nodes={placed.nodes} lit={lit} />
          ))}
          {placed.edges.map(({ edge, d, back }) => {
            const on = lit
              ? lit.has(edge.from) && lit.has(edge.to) && (edge.from === selected || edge.to === selected)
              : false;
            return (
              <path
                key={`${edge.from}>${edge.to}`}
                d={d}
                fill="none"
                stroke={on ? 'var(--accent)' : 'var(--fg-2)'}
                strokeOpacity={lit && !on ? 0.12 : on ? 0.95 : 0.5}
                strokeWidth={1 + Math.min(2, Math.log2(edge.lines.length))}
                strokeDasharray={back ? '4 3' : undefined}
                markerEnd={on ? 'url(#graph-arrow-lit)' : 'url(#graph-arrow)'}
              />
            );
          })}
          {placed.nodes.map((p) => (
            <Node
              key={p.node.id}
              placed={p}
              clustered={clustered}
              selected={p.node.id === selected}
              opacity={dim(p.node.id)}
            />
          ))}
        </g>
      </svg>
    </div>
  );
}

function Cluster({ cluster, nodes, lit }: { cluster: PlacedCluster; nodes: PlacedNode[]; lit: Set<string> | null }) {
  const inside = (n: PlacedNode) =>
    n.x >= cluster.x && n.x < cluster.x + cluster.w && n.y >= cluster.y && n.y < cluster.y + cluster.h;
  const members = nodes.filter((n) => n.node.path === cluster.path && inside(n));
  const unchanged = members.every((n) => n.node.status === 'consumer');
  const faded = lit && !members.some((n) => lit.has(n.node.id));
  const dir = dirname(cluster.path);
  const room = Math.floor((cluster.w - 20) / 6.6);
  const name = clip(basename(cluster.path), room);
  return (
    <g opacity={faded ? 0.25 : 1}>
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
      <text x={cluster.x + 10} y={cluster.y + CLUSTER_HEADER / 2 + 4} className="font-sans text-[11.5px]">
        <tspan className={unchanged ? 'fill-muted' : 'fill-foreground'} fontWeight={600}>
          {name}
        </tspan>
        {dir && room - name.length > 4 && (
          <tspan className="fill-muted" dx={6}>
            {clip(dir, room - name.length - 2)}
          </tspan>
        )}
      </text>
    </g>
  );
}

function Node({
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
  const room = Math.floor((w - 26) / 7.3);
  return (
    <g data-node={node.id} opacity={opacity} className="cursor-pointer">
      <title>{`${node.path}:${node.line}`}</title>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={6}
        fill={consumer ? 'var(--bg)' : 'var(--bg-2)'}
        stroke={selected ? 'var(--fg)' : STATUS_STROKE[node.status]}
        strokeWidth={selected ? 2 : consumer ? 1 : 1.5}
        strokeDasharray={consumer && !selected && !clustered ? '4 3' : undefined}
      />
      <circle
        cx={x + 11}
        cy={y + 14}
        r={3.5}
        fill={KIND_FILL[kindGroup(node.kind)] ?? 'var(--fg-2)'}
        opacity={consumer ? 0.6 : 1}
      />
      <text x={x + 20} y={y + 18} className={`font-mono text-[12px] ${consumer ? 'fill-muted' : 'fill-foreground'}`}>
        {clip(title, room)}
      </text>
      <text x={x + 20} y={y + 32} className="fill-muted font-sans text-[10.5px]">
        {clip(detail, Math.floor((w - 26) / 6.1))}
      </text>
      {node.moreConsumers ? (
        <g>
          <rect x={x - 34} y={y + h / 2 - 9} width={28} height={18} rx={9} fill="var(--bg-3)" />
          <text x={x - 20} y={y + h / 2 + 4} textAnchor="middle" className="fill-muted font-sans text-[10.5px]">
            +{node.moreConsumers}
          </text>
        </g>
      ) : null}
    </g>
  );
}
