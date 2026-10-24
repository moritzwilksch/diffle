import { type MouseEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { CanvasToolbar } from './CanvasToolbar.js';
import { GraphFind } from './GraphFind.js';
import { type EdgeLabel, GraphPart, type Lit } from './GraphPart.js';
import { groupName, PartHeader } from './PartHeader.js';
import { ArrowDefs, CANVAS_BG } from './GraphShapes.js';
import type { Box, PlacedNode } from '@/client/graph/layout/layout.js';
import { edgeKey } from '@/client/graph/layout/rank.js';
import { findMatches, useGraph, type View } from './state.js';

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
/** The dot grid's spacing at zoom 1. */
const GRID = 20;

const MARGIN = 48;
const MAX_ZOOM = 3;
const MIN_ZOOM = 0.15;
const FIT_ZOOM = 1.25;
/** Pixels per line, for wheels that scroll by lines. */
const LINE_PX = 16;
/** The most a file picked in the tree is zoomed in on: one box reads at its natural size. */
const FOCUS_ZOOM = 1;
/** The most a double-click zooms in on a node and its neighbours. */
const FRAME_ZOOM = 1.6;

/** What the keys and the side panel do to the mounted canvas: fit, zoom about the centre, frame a node. */
export const canvasControl = { fit: () => {}, zoom: (_factor: number) => {}, frame: (_id: string) => {} };

/**
 * The placed graph as SVG, panned by dragging and zoomed by the wheel. The selection, or the file
 * focused from the tree, stays lit with its links and the rest fades.
 */
export function GraphCanvas({ view: shown, clustered }: { view: View; clustered: boolean }) {
  const stacked = shown.stacked;
  const only = useGraph((s) => s.only);
  const selectedEdge = useGraph((s) => s.selectedEdge);
  // With nothing selected, the node under the pointer previews its links.
  const [hovered, setHovered] = useState<string | null>(null);
  const selected = useGraph((s) => s.selected);
  const focusPath = useGraph((s) => s.focusPath);
  const focusSeq = useGraph((s) => s.focusSeq);
  const find = useGraph((s) => s.find);
  const host = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<Viewport>({ x: 0, y: 0, k: 1 });
  // Pointer capture retargets the release to the host, so the press remembers which node it hit.
  const drag = useRef<Press | null>(null);
  const lastPress = useRef<Press | null>(null);

  const fitBox = (box: Box, maxZoom: number) => {
    const el = host.current;
    if (!el || !el.clientWidth) return;
    const [w, h] = [box.w + 2 * MARGIN, box.h + 2 * MARGIN];
    const k = Math.min(maxZoom, el.clientWidth / w, el.clientHeight / h);
    setView({
      k,
      x: (el.clientWidth - w * k) / 2 + (MARGIN - box.x) * k,
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
    canvasControl.frame = frame;
    canvasControl.zoom = (factor) => {
      const el = host.current;
      if (el) zoomAt(el.clientWidth / 2, el.clientHeight / 2, factor, true);
    };
  });

  // A file picked in the tree: frame its boxes, all of them, the same way on every pick.
  useEffect(() => {
    const boxes = stacked.nodes.filter((p) => p.node.path === focusPath);
    if (boxes.length) fitBox(bounds(boxes), FOCUS_ZOOM);
  }, [focusPath, focusSeq, stacked]);
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
    // While find has matches they stay lit, the current one (the selection) with its arrows.
    const matches = findMatches(shown, find);
    if (matches.length) {
      const seeds = new Set(selected ? [selected] : []);
      return {
        ids: new Set([...matches, ...seeds]),
        seeds,
        edge: null,
        marks: new Set(matches),
        query: find!.trim().toLowerCase(),
      };
    }
    const arrow = selectedEdge ? edges.find((e) => edgeKey(e) === selectedEdge) : undefined;
    if (arrow)
      return { ids: new Set([arrow.from, arrow.to]), seeds: new Set([arrow.from, arrow.to]), edge: selectedEdge };
    const focused = stacked.nodes.filter((p) => p.node.path === focusPath).map((p) => p.node.id);
    const seeds = selected ? [selected] : focused.length ? focused : hovered ? [hovered] : [];
    if (!seeds.length) return null;
    const ids = new Set(seeds);
    for (const edge of edges) if (seeds.includes(edge.from) || seeds.includes(edge.to)) ids.add(edge.from).add(edge.to);
    return { ids, seeds: new Set(seeds), edge: null };
  }, [shown, find, stacked, edges, selected, selectedEdge, focusPath, hovered]);
  const labels = useMemo(() => (clustered ? null : edgeLabels(shown)), [shown, clustered]);

  // Two-finger scrolling pans and a pinch (a wheel with Ctrl, as browsers report it) zooms. React's
  // wheel listeners are passive and cannot stop the page from scrolling along; this one can.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const onWheel = (e: globalThis.WheelEvent) => {
      e.preventDefault();
      const unit =
        e.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? LINE_PX
          : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? el.clientHeight
            : 1;
      const [dx, dy] = [e.deltaX * unit, e.deltaY * unit];
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-Math.max(-50, Math.min(50, dy)) * 0.01));
      } else setView((v) => ({ ...v, x: v.x - dx, y: v.y - dy, ease: false }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // zoomAt only calls the state setter, which React keeps stable.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const hit = (e: { target: EventTarget }, attr: string) =>
    (e.target as Element).closest(`[${attr}]`)?.getAttribute(attr) ?? null;
  const onPointerDown = (e: PointerEvent) => {
    drag.current = lastPress.current = {
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
    drag.current = lastPress.current = { ...d, x: e.clientX, y: e.clientY, moved: true };
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy, ease: false }));
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  // A double-click's second click is left to it: acting on it too would flash the selection off and on.
  const onClick = (e: MouseEvent) => {
    const d = lastPress.current;
    if (!d || d.moved || e.detail > 1) return;
    const graph = useGraph.getState();
    if (d.part != null) graph.showOnly(only ? null : d.part);
    else if (d.node == null && d.edge != null) graph.selectEdge(d.edge);
    else if (d.node != null || graph.selected || graph.selectedEdge) graph.select(d.node);
  };
  // A double-click frames a node with the nodes it links to; on the background it fits the graph.
  // Selects a node and frames it with the nodes it links to.
  const frame = (id: string) => {
    const near = new Set([id]);
    for (const edge of edges) if (edge.from === id || edge.to === id) near.add(edge.from).add(edge.to);
    useGraph.setState({ selected: id, selectedEdge: null, focusPath: null });
    const boxes = stacked.nodes.filter((p) => near.has(p.node.id));
    if (boxes.length) fitBox(bounds(boxes), FRAME_ZOOM);
  };
  const onDoubleClick = () => {
    // Pointer capture retargets the double-click to the host as well; the press knows what it hit.
    const press = lastPress.current;
    if (press?.part != null) return;
    const id = press?.node ?? null;
    if (id == null) return fit();
    frame(id);
  };

  return (
    <div className="relative h-full w-full">
      <div
        ref={host}
        className="relative h-full w-full cursor-grab touch-none overflow-hidden overscroll-none select-none active:cursor-grabbing"
        // A faint grey with a dot grid that pans and zooms with the graph: the cue that it drags.
        style={{
          backgroundColor: CANVAS_BG,
          backgroundImage: 'radial-gradient(color-mix(in srgb, var(--fg) 18%, transparent) 1px, transparent 1.2px)',
          backgroundSize: `${GRID * view.k}px ${GRID * view.k}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
          transition: view.ease
            ? `background-size ${EASE_MS}ms ease-out, background-position ${EASE_MS}ms ease-out`
            : undefined,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onClick={onClick}
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
                {(stacked.parts.length > 1 || stacked.unlinked || only != null) && (
                  <PartHeader
                    name={groupName(
                      part.hub,
                      part.placed.nodes.map((p) => p.node),
                      !clustered,
                    )}
                    count={part.placed.nodes.length}
                    noun={clustered ? 'symbol' : 'file'}
                    width={stacked.width}
                    action={{ partKey: part.key, showingOnly: only != null }}
                  />
                )}
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
                <PartHeader
                  name={{ plain: 'No links' }}
                  count={stacked.unlinked.placed.nodes.length}
                  noun={clustered ? 'symbol' : 'file'}
                  width={stacked.width}
                  action={null}
                />
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
      <GraphFind />
      <CanvasToolbar zoom={view.k} onZoom={(factor) => canvasControl.zoom(factor)} onFit={() => canvasControl.fit()} />
    </div>
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
    if (names.length) labels.set(key, { symbols: names.map(([name, { kind }]) => ({ name, kind })) });
  }
  return labels;
}

function bounds(boxes: PlacedNode[]): Box {
  const [x, y] = [Math.min(...boxes.map((b) => b.x)), Math.min(...boxes.map((b) => b.y))];
  const right = Math.max(...boxes.map((b) => b.x + b.w));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  return { x, y, w: right - x, h: bottom - y };
}
