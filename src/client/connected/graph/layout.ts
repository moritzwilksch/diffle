import dagre from '@dagrejs/dagre';
import type { GraphEdge, GraphModel, GraphNode } from './model.js';

export interface PlacedNode extends GraphNode {
  /** Centre. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface RoutedEdge extends GraphEdge {
  /** The routed polyline, from the caller's node to the callee's. */
  points: Point[];
  /** Where the label sits: the middle of the polyline. */
  label: Point;
}

export interface GraphLayout {
  nodes: PlacedNode[];
  edges: RoutedEdge[];
  width: number;
  height: number;
}

const NODE_HEIGHT = 48;
/** A test card is lower: secondary at a glance, and the rank of sources keeps its room. */
const TEST_HEIGHT = 40;
/** The room a test card's "test" tag takes from its name. */
export const TEST_TAG_WIDTH = 32;
const MIN_WIDTH = 148;
const MAX_WIDTH = 280;
// Wide enough for the name in the UI font plus its icon and counts, without measuring the DOM.
const CHAR_WIDTH = 7;
const NODE_PADDING = 64;
const RANK_SEP = 120;
// Room for the ←n →m counts under a card and the next card's focus ring.
const NODE_SEP = 40;
const EDGE_SEP = 16;
const MARGIN = 24;

const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const nodeWidth = (n: GraphNode): number =>
  Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n.name.length * CHAR_WIDTH + NODE_PADDING + (n.test ? TEST_TAG_WIDTH : 0)));

const round = (p: Point): Point => ({ x: Math.round(p.x), y: Math.round(p.y) });

/** The point halfway along the polyline's length. */
function midpoint(points: Point[]): Point {
  let total = 0;
  for (let i = 1; i < points.length; i++)
    total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  let left = total / 2;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len >= left && len > 0)
      return round({ x: a.x + ((b.x - a.x) * left) / len, y: a.y + ((b.y - a.y) * left) / len });
    left -= len;
  }
  return round(points[points.length - 1]!);
}

/**
 * Lays the model out left to right: callers left, callees right. Nodes and edges go into dagre sorted
 * by id, because dagre's result depends on insertion order; so equal models give equal pictures.
 */
export function layoutGraph(model: GraphModel): GraphLayout {
  if (model.nodes.length === 0) return { nodes: [], edges: [], width: 0, height: 0 };
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: 'LR',
    ranksep: RANK_SEP,
    nodesep: NODE_SEP,
    edgesep: EDGE_SEP,
    marginx: MARGIN,
    marginy: MARGIN,
  });
  g.setDefaultEdgeLabel(() => ({}));
  const nodes = [...model.nodes].sort(byId);
  const edges = [...model.edges].sort(byId);
  for (const n of nodes) g.setNode(n.id, { width: nodeWidth(n), height: n.test ? TEST_HEIGHT : NODE_HEIGHT });
  for (const e of edges) g.setEdge(e.from, e.to, { weight: e.weight });
  dagre.layout(g);

  const placed = nodes.map((n): PlacedNode => {
    const p = g.node(n.id);
    return { ...n, x: Math.round(p.x!), y: Math.round(p.y!), w: p.width, h: p.height };
  });
  const routed = edges.map((e): RoutedEdge => {
    const points = (g.edge(e.from, e.to).points ?? []).map(round);
    return { ...e, points, label: midpoint(points) };
  });
  const graph = g.graph();
  return { nodes: placed, edges: routed, width: Math.round(graph.width ?? 0), height: Math.round(graph.height ?? 0) };
}
