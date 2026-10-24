import { type MouseEvent, type PointerEvent, useEffect, useMemo, useRef, useState, type WheelEvent } from 'react';
import { PART_HEADER, type Stacked } from './components.js';
import { GraphPart, HEAD, type Lit } from './GraphPart.js';
import { ArrowDefs } from './GraphShapes.js';
import type { Box, PlacedNode } from './layout.js';
import { useGraph } from './state.js';

interface View {
  x: number;
  y: number;
  k: number;
}

const MARGIN = 48;
const MAX_ZOOM = 3;
const MIN_ZOOM = 0.15;
const FIT_ZOOM = 1.25;

/** What the keys do to the mounted canvas: fit the graph, zoom about the centre. */
export const canvasControl = { fit: () => {}, zoom: (_factor: number) => {} };

/**
 * The placed graph as SVG, panned by dragging and zoomed by the wheel. The selection, or the file
 * focused from the tree, stays lit with its links and the rest fades. A double-click on a node
 * jumps to it in the diff; on the background it fits the graph.
 */
export function GraphCanvas({ stacked, clustered }: { stacked: Stacked; clustered: boolean }) {
  const only = useGraph((s) => s.only);
  const selected = useGraph((s) => s.selected);
  const focusPath = useGraph((s) => s.focusPath);
  const host = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  // Pointer capture retargets the release to the host, so the press remembers which node it hit.
  const drag = useRef<{ x: number; y: number; moved: boolean; node: string | null; part: string | null } | null>(null);

  const fitBox = (box: Box, maxZoom: number) => {
    const el = host.current;
    if (!el || !el.clientWidth) return;
    // The layer labels sit in a gutter left of the graph.
    const [w, h] = [box.w + 2 * MARGIN + HEAD, box.h + 2 * MARGIN];
    const k = Math.min(maxZoom, el.clientWidth / w, el.clientHeight / h);
    setView({
      k,
      x: (el.clientWidth - w * k) / 2 + (MARGIN + HEAD - box.x) * k,
      y: (el.clientHeight - h * k) / 2 + (MARGIN - box.y) * k,
    });
  };
  const zoomAt = (px: number, py: number, factor: number) =>
    setView((v) => {
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * factor));
      return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
    });
  const fit = () => fitBox({ x: 0, y: 0, w: stacked.width, h: stacked.height }, FIT_ZOOM);
  useEffect(fit, [stacked]);
  useEffect(() => {
    canvasControl.fit = fit;
    canvasControl.zoom = (factor) => {
      const el = host.current;
      if (el) zoomAt(el.clientWidth / 2, el.clientHeight / 2, factor);
    };
  });

  // A file picked in the tree: show its boxes whole.
  useEffect(() => {
    const boxes = stacked.nodes.filter((p) => p.node.path === focusPath);
    if (boxes.length) fitBox(bounds(boxes), 1);
  }, [focusPath, stacked]);
  // A selection moved by the keys: bring it into view when it left it.
  useEffect(() => {
    const p = stacked.nodes.find((n) => n.node.id === selected);
    const el = host.current;
    if (!p || !el) return;
    setView((v) => {
      const [left, top] = [p.x * v.k + v.x, p.y * v.k + v.y];
      const inside = left >= 0 && top >= 0 && left + p.w * v.k <= el.clientWidth && top + p.h * v.k <= el.clientHeight;
      if (inside) return v;
      return { ...v, x: el.clientWidth / 2 - (p.x + p.w / 2) * v.k, y: el.clientHeight / 2 - (p.y + p.h / 2) * v.k };
    });
  }, [selected, stacked]);

  const edges = useMemo(() => stacked.parts.flatMap((p) => p.placed.edges.map((e) => e.edge)), [stacked]);
  const lit = useMemo((): Lit | null => {
    const seeds = selected ? [selected] : stacked.nodes.filter((p) => p.node.path === focusPath).map((p) => p.node.id);
    if (!seeds.length) return null;
    const ids = new Set(seeds);
    for (const edge of edges) if (seeds.includes(edge.from) || seeds.includes(edge.to)) ids.add(edge.from).add(edge.to);
    return { ids, seeds: new Set(seeds) };
  }, [stacked, edges, selected, focusPath]);

  const onWheel = (e: WheelEvent) => {
    const rect = host.current!.getBoundingClientRect();
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.0015));
  };
  const hit = (e: { target: EventTarget }, attr: string) =>
    (e.target as Element).closest(`[${attr}]`)?.getAttribute(attr) ?? null;
  const onPointerDown = (e: PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, moved: false, node: hit(e, 'data-node'), part: hit(e, 'data-part') };
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
    if (!d || d.moved) return;
    if (d.part != null) useGraph.getState().showOnly(only ? null : d.part);
    else useGraph.getState().select(d.node);
  };
  const onDoubleClick = (e: MouseEvent) => {
    if (hit(e, 'data-part') != null) return;
    const node = stacked.nodes.find((p) => p.node.id === hit(e, 'data-node'))?.node;
    if (node) useGraph.getState().pick({ path: node.path, line: node.line });
    else fit();
  };

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
          {stacked.parts.map((part) => (
            <g key={part.key} transform={`translate(${part.x},${part.y})`}>
              <PartHeader
                title={part.hub.name}
                size={part.placed.nodes.length}
                showingOnly={only != null}
                partKey={part.key}
                single={stacked.parts.length === 1 && only == null}
              />
              <GraphPart placed={part.placed} clustered={clustered} selected={selected} lit={lit} />
            </g>
          ))}
          {stacked.unlinked && (
            <g transform={`translate(0,${stacked.unlinked.y})`}>
              <GraphPart placed={stacked.unlinked.placed} clustered={clustered} selected={selected} lit={lit} />
            </g>
          )}
        </g>
      </svg>
    </div>
  );
}

/** A part's name, after its most-used symbol, and the switch between it alone and every part. */
function PartHeader({
  title,
  size,
  showingOnly,
  partKey,
  single,
}: {
  title: string;
  size: number;
  showingOnly: boolean;
  partKey: string;
  single: boolean;
}) {
  if (single) return null;
  const y = -PART_HEADER + 14;
  return (
    <g>
      <text x={0} y={y} className="font-sans text-[13px]">
        <tspan className="fill-muted">around </tspan>
        <tspan className="fill-foreground font-mono" fontWeight={600}>
          {title}
        </tspan>
        <tspan className="fill-muted"> · {size} symbols · </tspan>
        <tspan data-part={partKey} className="cursor-pointer fill-accent">
          {showingOnly ? 'show every part' : 'show only this'}
        </tspan>
      </text>
    </g>
  );
}

function bounds(boxes: PlacedNode[]): Box {
  const [x, y] = [Math.min(...boxes.map((b) => b.x)), Math.min(...boxes.map((b) => b.y))];
  const right = Math.max(...boxes.map((b) => b.x + b.w));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  return { x, y, w: right - x, h: bottom - y };
}
