import { type MouseEvent, type PointerEvent, useEffect, useMemo, useRef, useState, type WheelEvent } from 'react';
import { ArrowDefs, Cluster, Node } from './GraphShapes.js';
import type { Box, Placed, PlacedNode } from './layout.js';
import { useGraph } from './state.js';

interface View {
  x: number;
  y: number;
  k: number;
}

const MARGIN = 48;
const HEAD = 28;
const MAX_ZOOM = 3;
const MIN_ZOOM = 0.15;
const FIT_ZOOM = 1.25;
const FADED = 0.18;

/** What the keys do to the mounted canvas: fit the graph, zoom about the centre. */
export const canvasControl = { fit: () => {}, zoom: (_factor: number) => {} };

/**
 * The placed graph as SVG, panned by dragging and zoomed by the wheel. The selection, or the file
 * focused from the tree, stays lit with its links and the rest fades. A double-click on a node
 * jumps to it in the diff; on the background it fits the graph.
 */
export function GraphCanvas({ placed, clustered }: { placed: Placed; clustered: boolean }) {
  const selected = useGraph((s) => s.selected);
  const focusPath = useGraph((s) => s.focusPath);
  const host = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  // Pointer capture retargets the release to the host, so the press remembers which node it hit.
  const drag = useRef<{ x: number; y: number; moved: boolean; node: string | null } | null>(null);

  const fitBox = (box: Box, maxZoom: number) => {
    const el = host.current;
    if (!el || !el.clientWidth) return;
    const [w, h] = [box.w + 2 * MARGIN, box.h + 2 * MARGIN + HEAD];
    const k = Math.min(maxZoom, el.clientWidth / w, el.clientHeight / h);
    setView({
      k,
      x: (el.clientWidth - w * k) / 2 + (MARGIN - box.x) * k,
      y: (el.clientHeight - h * k) / 2 + (MARGIN + HEAD - box.y) * k,
    });
  };
  const zoomAt = (px: number, py: number, factor: number) =>
    setView((v) => {
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * factor));
      return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
    });
  const fit = () => fitBox({ x: 0, y: 0, w: placed.width, h: placed.height }, FIT_ZOOM);
  useEffect(fit, [placed]);
  useEffect(() => {
    canvasControl.fit = fit;
    canvasControl.zoom = (factor) => {
      const el = host.current;
      if (el) zoomAt(el.clientWidth / 2, el.clientHeight / 2, factor);
    };
  });

  // A file picked in the tree: show its boxes whole.
  useEffect(() => {
    const boxes = placed.nodes.filter((p) => p.node.path === focusPath);
    if (boxes.length) fitBox(bounds(boxes), 1);
  }, [focusPath, placed]);
  // A selection moved by the keys: bring it into view when it left it.
  useEffect(() => {
    const p = placed.nodes.find((n) => n.node.id === selected);
    const el = host.current;
    if (!p || !el) return;
    setView((v) => {
      const [left, top] = [p.x * v.k + v.x, p.y * v.k + v.y];
      const inside = left >= 0 && top >= 0 && left + p.w * v.k <= el.clientWidth && top + p.h * v.k <= el.clientHeight;
      if (inside) return v;
      return { ...v, x: el.clientWidth / 2 - (p.x + p.w / 2) * v.k, y: el.clientHeight / 2 - (p.y + p.h / 2) * v.k };
    });
  }, [selected, placed]);

  const lit = useMemo(() => {
    const seeds = selected ? [selected] : placed.nodes.filter((p) => p.node.path === focusPath).map((p) => p.node.id);
    if (!seeds.length) return null;
    const ids = new Set(seeds);
    for (const { edge } of placed.edges)
      if (seeds.includes(edge.from) || seeds.includes(edge.to)) ids.add(edge.from).add(edge.to);
    return { ids, seeds: new Set(seeds) };
  }, [placed, selected, focusPath]);

  const onWheel = (e: WheelEvent) => {
    const rect = host.current!.getBoundingClientRect();
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.0015));
  };
  const nodeAt = (e: { target: EventTarget }) =>
    (e.target as Element).closest('[data-node]')?.getAttribute('data-node') ?? null;
  const onPointerDown = (e: PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, moved: false, node: nodeAt(e) };
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
    if (d && !d.moved) useGraph.getState().select(d.node);
  };
  const onDoubleClick = (e: MouseEvent) => {
    const node = placed.nodes.find((p) => p.node.id === nodeAt(e))?.node;
    if (node) useGraph.getState().pick({ path: node.path, line: node.line });
    else fit();
  };

  const opacity = (ids: string[]) => (lit && !ids.some((id) => lit.ids.has(id)) ? FADED : 1);
  return (
    <div
      ref={host}
      className="relative h-full w-full cursor-grab touch-none overflow-hidden bg-canvas select-none active:cursor-grabbing"
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={onDoubleClick}
    >
      <svg className="absolute inset-0 h-full w-full" role="img" aria-label="Change graph">
        <ArrowDefs />
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
          {placed.clusters.map((c) => {
            const members = placed.nodes.filter((n) => n.node.path === c.path && within(n, c));
            return (
              <Cluster
                key={`${c.path}@${c.column}@${c.y}`}
                cluster={c}
                members={members}
                opacity={opacity(members.map((n) => n.node.id)) === 1 ? 1 : 0.25}
              />
            );
          })}
          {placed.edges.map(({ edge, d, back }) => {
            const on = !!lit && (lit.seeds.has(edge.from) || lit.seeds.has(edge.to));
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
              opacity={opacity([p.node.id])}
            />
          ))}
        </g>
      </svg>
    </div>
  );
}

const within = (n: Box, c: Box) => n.x >= c.x && n.x < c.x + c.w && n.y >= c.y && n.y < c.y + c.h;

function bounds(boxes: PlacedNode[]): Box {
  const [x, y] = [Math.min(...boxes.map((b) => b.x)), Math.min(...boxes.map((b) => b.y))];
  const right = Math.max(...boxes.map((b) => b.x + b.w));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  return { x, y, w: right - x, h: bottom - y };
}
