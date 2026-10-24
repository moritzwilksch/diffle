import { type MouseEvent, type PointerEvent, useEffect, useMemo, useRef, useState, type WheelEvent } from 'react';
import { PART_HEADER } from '@/client/graph/layout/components.js';
import { type EdgeLabel, GraphPart, HEAD, type Lit } from './GraphPart.js';
import { GraphLegend, ZoomControls } from './GraphLegend.js';
import { ArrowDefs } from './GraphShapes.js';
import type { Box, PlacedNode } from '@/client/graph/layout/layout.js';
import { edgeKey } from '@/client/graph/layout/rank.js';
import { useGraph, type View } from './state.js';

/** A press on the canvas, and what it landed on: a node, an arrow, or a part's header action. */
interface Press {
  x: number;
  y: number;
  moved: boolean;
  node: string | null;
  edge: string | null;
  part: string | null;
}

interface Viewport {
  x: number;
  y: number;
  k: number;
  /** Glide to this view: a fit or a focus does, a drag or the wheel follows the pointer at once. */
  ease?: boolean;
}

const EASE_MS = 200;

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
export function GraphCanvas({ view: shown, clustered }: { view: View; clustered: boolean }) {
  const stacked = shown.stacked;
  const only = useGraph((s) => s.only);
  const selectedEdge = useGraph((s) => s.selectedEdge);
  // With nothing selected, the node under the pointer previews its links.
  const [hovered, setHovered] = useState<string | null>(null);
  const selected = useGraph((s) => s.selected);
  const focusPath = useGraph((s) => s.focusPath);
  const host = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<Viewport>({ x: 0, y: 0, k: 1 });
  // Pointer capture retargets the release to the host, so the press remembers which node it hit.
  const drag = useRef<Press | null>(null);

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
      ease: true,
    });
  };
  const zoomAt = (px: number, py: number, factor: number, ease = false) =>
    setView((v) => {
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * factor));
      return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k, ease };
    });
  const fit = () => fitBox({ x: 0, y: 0, w: stacked.width, h: stacked.height }, FIT_ZOOM);
  useEffect(fit, [stacked]);
  useEffect(() => {
    canvasControl.fit = fit;
    canvasControl.zoom = (factor) => {
      const el = host.current;
      if (el) zoomAt(el.clientWidth / 2, el.clientHeight / 2, factor, true);
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
      const [x, y] = [el.clientWidth / 2 - (p.x + p.w / 2) * v.k, el.clientHeight / 2 - (p.y + p.h / 2) * v.k];
      return { ...v, x, y, ease: true };
    });
  }, [selected, stacked]);

  const edges = useMemo(() => stacked.parts.flatMap((p) => p.placed.edges.map((e) => e.edge)), [stacked]);
  const lit = useMemo((): Lit | null => {
    const arrow = selectedEdge ? edges.find((e) => edgeKey(e) === selectedEdge) : undefined;
    if (arrow)
      return { ids: new Set([arrow.from, arrow.to]), seeds: new Set([arrow.from, arrow.to]), edge: selectedEdge };
    const focused = stacked.nodes.filter((p) => p.node.path === focusPath).map((p) => p.node.id);
    const seeds = selected ? [selected] : focused.length ? focused : hovered ? [hovered] : [];
    if (!seeds.length) return null;
    const ids = new Set(seeds);
    for (const edge of edges) if (seeds.includes(edge.from) || seeds.includes(edge.to)) ids.add(edge.from).add(edge.to);
    return { ids, seeds: new Set(seeds), edge: null };
  }, [stacked, edges, selected, selectedEdge, focusPath, hovered]);
  const labels = useMemo(() => (clustered ? null : edgeLabels(shown)), [shown, clustered]);

  const onWheel = (e: WheelEvent) => {
    const rect = host.current!.getBoundingClientRect();
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.0015));
  };
  const hit = (e: { target: EventTarget }, attr: string) =>
    (e.target as Element).closest(`[${attr}]`)?.getAttribute(attr) ?? null;
  const onPointerDown = (e: PointerEvent) => {
    drag.current = {
      x: e.clientX,
      y: e.clientY,
      moved: false,
      node: hit(e, 'data-node'),
      edge: hit(e, 'data-edge'),
      part: hit(e, 'data-part'),
    };
    host.current!.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const [dx, dy] = [e.clientX - d.x, e.clientY - d.y];
    if (!d.moved && Math.hypot(dx, dy) < 3) return;
    drag.current = { ...d, x: e.clientX, y: e.clientY, moved: true };
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy, ease: false }));
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved) return;
    const graph = useGraph.getState();
    if (d.part != null) graph.showOnly(only ? null : d.part);
    else if (d.node == null && d.edge != null) graph.selectEdge(d.edge);
    else if (d.node != null || graph.selected || graph.selectedEdge) graph.select(d.node);
  };
  const onDoubleClick = (e: MouseEvent) => {
    if (hit(e, 'data-part') != null) return;
    const node = stacked.nodes.find((p) => p.node.id === hit(e, 'data-node'))?.node;
    if (node) useGraph.getState().pick({ path: node.path, line: node.line });
    else fit();
  };

  return (
    <div className="relative h-full w-full">
      <div
        ref={host}
        className="relative h-full w-full cursor-grab touch-none overflow-hidden bg-canvas select-none active:cursor-grabbing"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={onDoubleClick}
        onPointerOver={(e) => setHovered(hit(e, 'data-node'))}
        onPointerLeave={() => setHovered(null)}
      >
        <svg className="absolute inset-0 h-full w-full" role="img" aria-label="Change graph">
          <ArrowDefs />
          <g
            style={{
              transform: `translate(${view.x}px,${view.y}px) scale(${view.k})`,
              transformOrigin: '0 0',
              transition: view.ease ? `transform ${EASE_MS}ms ease-out` : undefined,
            }}
            className="motion-reduce:transition-none!"
          >
            {stacked.parts.map((part) => (
              <g key={part.key} transform={`translate(${part.x},${part.y})`}>
                <PartHeader
                  title={part.hub.name}
                  size={part.placed.nodes.length}
                  showingOnly={only != null}
                  partKey={part.key}
                  single={stacked.parts.length === 1 && only == null}
                />
                <GraphPart
                  placed={part.placed}
                  clustered={clustered}
                  selected={selected}
                  lit={lit}
                  zoom={view.k}
                  labels={labels}
                />
              </g>
            ))}
            {stacked.unlinked && (
              <g transform={`translate(0,${stacked.unlinked.y})`}>
                <GraphPart
                  placed={stacked.unlinked.placed}
                  clustered={clustered}
                  selected={selected}
                  lit={lit}
                  zoom={view.k}
                  labels={labels}
                />
              </g>
            )}
          </g>
        </svg>
      </div>
      {/* Beside the canvas, not in it: the canvas captures the pointer on press. */}
      <GraphLegend />
      <ZoomControls zoom={canvasControl.zoom} fit={() => canvasControl.fit()} />
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

/** File view's arrow labels: the symbols each file arrow uses, by name, the most-used first. */
function edgeLabels(view: View): Map<string, EdgeLabel> {
  const byId = new Map(view.symbols.nodes.map((n) => [n.id, n]));
  const labels = new Map<string, EdgeLabel>();
  for (const [key, behind] of view.via) {
    const weight = new Map<string, { kind: number; n: number }>();
    for (const e of behind) {
      const to = byId.get(e.to);
      if (!to || to.kind === 1) continue;
      const w = weight.get(to.name) ?? { kind: to.kind, n: 0 };
      weight.set(to.name, { ...w, n: w.n + e.lines.length });
    }
    const names = [...weight].sort((a, b) => b[1].n - a[1].n);
    if (names.length) labels.set(key, { kind: names[0]![1].kind, names: names.map(([name]) => name) });
  }
  return labels;
}

function bounds(boxes: PlacedNode[]): Box {
  const [x, y] = [Math.min(...boxes.map((b) => b.x)), Math.min(...boxes.map((b) => b.y))];
  const right = Math.max(...boxes.map((b) => b.x + b.w));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  return { x, y, w: right - x, h: bottom - y };
}
