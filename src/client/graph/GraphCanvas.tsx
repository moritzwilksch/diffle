import { type MouseEvent, useEffect, useMemo, useState } from 'react';
import { CanvasSurface } from '@/client/canvas/CanvasSurface.js';
import { CanvasToolbar } from '@/client/canvas/CanvasToolbar.js';
import { edgeKey } from '@/client/canvas/layout/rank.js';
import { attrOf, bounds, type CanvasControl, useViewport, zoomCentre } from '@/client/canvas/viewport.js';
import { GraphFind } from './GraphFind.js';
import { type EdgeLabel, GraphPart, type Lit } from './GraphPart.js';
import { Legend } from './Legend.js';
import { PartHeader } from './PartHeader.js';
import { findMatches, useGraph, type View } from './state.js';

const FIT_ZOOM = 1.25;
/** The most a file picked in the tree is zoomed in on: one box reads at its natural size. */
const FOCUS_ZOOM = 1;
/** The most a double-click zooms in on a node and its neighbours. */
const FRAME_ZOOM = 1.6;

/** What the keys and the side panel do to the mounted canvas: fit, zoom about the centre, frame a node. */
export const canvasControl: CanvasControl & { frame: (id: string) => void } = {
  fit: () => {},
  zoom: () => {},
  frame: () => {},
};

/**
 * The placed graph as SVG, panned by dragging and zoomed by the wheel. The selection, or the file
 * focused from the tree, stays lit with its links and the rest fades.
 */
export function GraphCanvas({ view: shown, clustered }: { view: View; clustered: boolean }) {
  const stacked = shown.stacked;
  const only = useGraph((s) => s.only);
  const grouped = stacked.parts.length > 1 || !!stacked.unlinked || only != null;
  const selectedEdge = useGraph((s) => s.selectedEdge);
  // With nothing selected, the node under the pointer previews its links.
  const [hovered, setHovered] = useState<string | null>(null);
  const selected = useGraph((s) => s.selected);
  const focusPath = useGraph((s) => s.focusPath);
  const focusSeq = useGraph((s) => s.focusSeq);
  const find = useGraph((s) => s.find);
  const viewport = useViewport();
  const { view, fitBox, reveal } = viewport;

  const fit = () => fitBox({ x: 0, y: 0, w: stacked.width, h: stacked.height }, FIT_ZOOM);
  useEffect(() => fitBox({ x: 0, y: 0, w: stacked.width, h: stacked.height }, FIT_ZOOM), [stacked, fitBox]);

  // A file picked in the tree: frame its boxes, all of them, the same way on every pick.
  useEffect(() => {
    const boxes = stacked.nodes.filter((p) => p.node.path === focusPath);
    if (boxes.length) fitBox(bounds(boxes), FOCUS_ZOOM);
  }, [focusPath, focusSeq, stacked, fitBox]);
  // A selection moved by the keys: bring it into view when it left it.
  useEffect(() => {
    const p = stacked.nodes.find((n) => n.node.id === selected);
    if (p) reveal(p);
  }, [selected, stacked, reveal]);

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

  // A double-click's second click is left to it: acting on it too would flash the selection off and on.
  const onClick = (e: MouseEvent) => {
    const d = viewport.press.current;
    if (!d || d.moved || e.detail > 1) return;
    const graph = useGraph.getState();
    const [node, edge, part] = [
      attrOf(d.target, 'data-node'),
      attrOf(d.target, 'data-edge'),
      attrOf(d.target, 'data-part'),
    ];
    if (part != null) graph.showOnly(only ? null : part);
    else if (node == null && edge != null) graph.selectEdge(edge);
    else if (node != null || graph.selected || graph.selectedEdge) graph.select(node);
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
  useEffect(() => {
    canvasControl.fit = fit;
    canvasControl.frame = frame;
    canvasControl.zoom = (factor) => zoomCentre(viewport, factor);
  });
  const onDoubleClick = () => {
    // Pointer capture retargets the double-click to the host as well; the press knows what it hit.
    const press = viewport.press.current;
    if (attrOf(press?.target, 'data-part') != null) return;
    const id = attrOf(press?.target, 'data-node');
    if (id == null) return fit();
    frame(id);
  };

  return (
    <div className="relative h-full w-full">
      <CanvasSurface
        viewport={viewport}
        label="Change graph"
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onPointerOver={(e) => setHovered(attrOf(e.target, 'data-node'))}
        onPointerLeave={() => setHovered(null)}
        svg={
          <>
            {stacked.parts.map((part) => (
              <g key={part.key} transform={`translate(${part.x},${part.y})`}>
                {/* A lone part's header still names the folder its boxes leave out, without the switch. */}
                {(grouped || part.folder) && (
                  <PartHeader
                    name={part.folder ? { folder: part.folder } : { hub: part.hub }}
                    count={part.placed.nodes.length}
                    noun={clustered ? 'symbol' : 'file'}
                    width={stacked.width}
                    action={grouped ? { partKey: part.key, showingOnly: only != null } : null}
                  />
                )}
                <GraphPart
                  placed={part.placed}
                  folder={part.folder}
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
                  folder=""
                  clustered={clustered}
                  selected={selected}
                  lit={lit}
                  zoom={view.k}
                  labels={labels}
                />
              </g>
            )}
          </>
        }
      />
      {/* Beside the canvas, not in it: the canvas captures the pointer on press. */}
      <GraphFind />
      <CanvasToolbar
        zoom={view.k}
        onZoom={(factor) => canvasControl.zoom(factor)}
        onFit={() => canvasControl.fit()}
        legend={<Legend />}
      />
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
