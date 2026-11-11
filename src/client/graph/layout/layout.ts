import type { GraphEdge, GraphNode } from '@/shared/protocol.js';
import { type Block, bySource, order, type Route } from './order.js';
import type { Graph, Ranked } from './rank.js';

export interface Size {
  w: number;
  h: number;
}

export interface Box extends Size {
  x: number;
  y: number;
}

export interface PlacedNode extends Box {
  node: GraphNode;
}

/** A file's symbols within one layer. */
export interface PlacedCluster extends Box {
  path: string;
  /** -1 on the shelf of unlinked symbols. */
  layer: number;
}

export interface PlacedEdge {
  edge: GraphEdge;
  /** SVG path data. */
  d: string;
  /** A point on the path, 0 to 1 along its segments; a label sits at 0.5 unless that is taken. */
  along: (t: number) => Point;
  /** Runs inside a cycle, within one layer. */
  back: boolean;
}

export interface Placed {
  nodes: PlacedNode[];
  clusters: PlacedCluster[];
  edges: PlacedEdge[];
  /** One band per rank, entry at the top. */
  layers: { y: number; h: number }[];
  /** Top of the shelf below the layers holding the symbols with no links, when there are any. */
  shelf: number | null;
  width: number;
  height: number;
}

export const CLUSTER_HEADER = 26;
const CLUSTER_PAD = 8;
const NODE_GAP = 8;
/** A cluster wraps its symbols onto a new row after this many, so a big file stays compact. */
const ROW_MEMBERS = 4;
const BLOCK_GAP = 22;
const LAYER_GAP = 96;
const WAYPOINT_W = 4;
const RELAX_PASSES = 8;
/** How far a cycle's edge bows out into the gap below its layer. */
const BACK_BOW = 44;
/** The most space between edge ends sharing one side of a box, and the share of its width they spread over. */
const PORT_STEP = 28;
const PORT_SPAN = 0.7;
const SHELF_GAP = 72;
const SHELF_MIN_W = 960;

/**
 * Places a ranked graph top to bottom: a band per rank, entry points first, blocks side by side in
 * the crossing-reduced order, each pulled toward the blocks it links to without changing the order
 * or overlapping. A cluster is its file's header over its symbols.
 */
export function layout(graph: Graph, ranked: Ranked, size: (n: GraphNode) => Size, clustered: boolean): Placed {
  // A symbol with no links has no rank to show; it waits on a shelf below instead of crowding the core.
  const linked = new Set(graph.edges.flatMap((e) => [e.from, e.to]));
  const unlinked = graph.nodes.filter((n) => !linked.has(n.id)).sort(bySource);
  const { layers, routes } = order(
    { nodes: graph.nodes.filter((n) => linked.has(n.id)), edges: graph.edges },
    ranked,
    clustered,
  );
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const sizeOf = new Map(graph.nodes.map((n) => [n.id, size(n)]));
  const memberSize = (id: string): Size => sizeOf.get(id) ?? { w: WAYPOINT_W, h: 0 };

  // Each member's offset inside its block, and each block's size.
  const offset = new Map<string, { x: number; y: number }>();
  const dims = new Map<Block, Size>();
  for (const b of layers.flat()) dims.set(b, arrange(b.path != null, b.members, memberSize, offset));
  const bands: { y: number; h: number }[] = [];
  let y = 0;
  for (const layer of layers) {
    const h = Math.max(0, ...layer.filter((b) => !b.waypoint).map((b) => dims.get(b)!.h));
    bands.push({ y, h });
    y += h + LAYER_GAP;
  }
  // Waypoints run the height of their band, so an edge passes it straight down.
  layers.forEach((layer, i) => layer.filter((b) => b.waypoint).forEach((b) => (dims.get(b)!.h = bands[i]!.h)));

  const left = new Map<Block, number>();
  for (const layer of layers) {
    let x = 0;
    for (const b of layer) {
      left.set(b, x);
      x += dims.get(b)!.w + BLOCK_GAP;
    }
  }
  const blockOf = new Map(layers.flat().flatMap((b) => b.members.map((id) => [id, b] as const)));
  const center = (id: string) => left.get(blockOf.get(id)!)! + offset.get(id)!.x + memberSize(id).w / 2;
  const neighbours = new Map<string, string[]>();
  for (const r of routes) {
    const chain = [r.from, ...r.stops, r.to];
    for (let i = 1; i < chain.length; i++) {
      const [a, b] = [chain[i - 1]!, chain[i]!];
      neighbours.set(a, [...(neighbours.get(a) ?? []), b]);
      neighbours.set(b, [...(neighbours.get(b) ?? []), a]);
    }
  }
  for (let pass = 0; pass < RELAX_PASSES; pass++) {
    for (const layer of layers) {
      const wanted = layer.map((b) => {
        const pulls = b.members.flatMap((id) =>
          (neighbours.get(id) ?? []).map((n) => center(n) - offset.get(id)!.x - memberSize(id).w / 2),
        );
        return pulls.length ? pulls.reduce((s, p) => s + p, 0) / pulls.length : left.get(b)!;
      });
      const placed = keepOrder(
        wanted,
        layer.map((b) => dims.get(b)!.w + BLOCK_GAP),
      );
      layer.forEach((b, i) => left.set(b, placed[i]!));
    }
  }
  const minLeft = Math.min(0, ...left.values());
  for (const [b, x] of left) left.set(b, x - minLeft);

  const nodes: PlacedNode[] = [];
  const clusters: PlacedCluster[] = [];
  // Where arrows attach: a symbol's own column, but a cluster's top and bottom edge, so no arrow
  // crosses the file name heading the cluster or the symbols above its row.
  const boxOf = new Map<string, Box>();
  layers.forEach((layer, i) => {
    const top = bands[i]!.y;
    for (const b of layer) {
      const [x, d] = [left.get(b)!, dims.get(b)!];
      if (b.path != null) clusters.push({ path: b.path, layer: i, x, y: top, ...d });
      for (const id of b.members) {
        const box = { x: x + offset.get(id)!.x, y: top + offset.get(id)!.y, ...memberSize(id) };
        if (b.waypoint) box.h = d.h;
        boxOf.set(id, b.path != null ? { ...box, y: top, h: d.h } : box);
        if (!b.waypoint) nodes.push({ node: nodeById.get(id)!, ...box });
      }
    }
  });

  const edges = route(graph.edges, routes, boxOf);
  const width = Math.max(0, ...[...left].map(([b, x]) => x + dims.get(b)!.w));
  const layersH = Math.max(0, y - LAYER_GAP);
  if (!unlinked.length) return { nodes, clusters, edges, layers: bands, shelf: null, width, height: layersH };

  const shelf = linked.size ? layersH + SHELF_GAP : 0;
  const shelfW = Math.max(width, SHELF_MIN_W);
  let [sx, sy, rowH, right] = [0, shelf, 0, width];
  const files = new Map<string, string[]>();
  for (const n of unlinked) {
    const key = clustered ? n.path : n.id;
    files.set(key, [...(files.get(key) ?? []), n.id]);
  }
  for (const [path, members] of files) {
    const d = arrange(clustered, members, memberSize, offset);
    if (sx > 0 && sx + d.w > shelfW) [sx, sy, rowH] = [0, sy + rowH + BLOCK_GAP, 0];
    if (clustered) clusters.push({ path, layer: -1, x: sx, y: sy, ...d });
    for (const id of members)
      nodes.push({ node: nodeById.get(id)!, x: sx + offset.get(id)!.x, y: sy + offset.get(id)!.y, ...memberSize(id) });
    right = Math.max(right, sx + d.w);
    sx += d.w + BLOCK_GAP;
    rowH = Math.max(rowH, d.h);
  }
  return { nodes, clusters, edges, layers: bands, shelf, width: right, height: sy + rowH };
}

/**
 * Lays a block's members out and records each one's offset: a cluster puts its file's header on
 * top and its symbols in rows of `ROW_MEMBERS`; any other block is its one member.
 */
function arrange(
  cluster: boolean,
  members: string[],
  size: (id: string) => Size,
  offset: Map<string, { x: number; y: number }>,
): Size {
  if (!cluster) {
    offset.set(members[0]!, { x: 0, y: 0 });
    return { ...size(members[0]!) };
  }
  let [x, y, rowH, w] = [CLUSTER_PAD, CLUSTER_HEADER, 0, 0];
  members.forEach((id, i) => {
    if (i > 0 && i % ROW_MEMBERS === 0) [x, y, rowH] = [CLUSTER_PAD, y + rowH + NODE_GAP, 0];
    offset.set(id, { x, y });
    const s = size(id);
    x += s.w + NODE_GAP;
    rowH = Math.max(rowH, s.h);
    w = Math.max(w, x - NODE_GAP + CLUSTER_PAD);
  });
  return { w, h: y + rowH + CLUSTER_PAD };
}

/**
 * Each edge as a path: curves through its waypoints, leaving each box downward and entering the
 * next from above, or a bow below for a cycle's edge. Edge ends sharing a side of a box spread
 * along it in the order of where they come from or go.
 */
function route(edges: GraphEdge[], routes: Route[], boxOf: Map<string, Box>): PlacedEdge[] {
  const routed = new Map(routes.map((r) => [`${r.from}>${r.to}`, r]));
  const mid = (b: Box): number => b.x + b.w / 2;
  const lines = edges.map((edge) => {
    const [from, to] = [boxOf.get(edge.from)!, boxOf.get(edge.to)!];
    const r = routed.get(`${edge.from}>${edge.to}`);
    if (!r) return { edge, points: null };
    const points: [number, number][] = [[mid(from), from.y + from.h]];
    for (const stop of r.stops) {
      const b = boxOf.get(stop)!;
      points.push([mid(b), b.y], [mid(b), b.y + b.h]);
    }
    points.push([mid(to), to.y]);
    return { edge, points };
  });
  const spread = (ends: { point: [number, number]; toward: number }[], box: Box) => {
    ends.sort((a, b) => a.toward - b.toward);
    const step = ends.length > 1 ? Math.min(PORT_STEP, (box.w * PORT_SPAN) / (ends.length - 1)) : 0;
    ends.forEach((end, i) => (end.point[0] = mid(box) + (i - (ends.length - 1) / 2) * step));
  };
  for (const [id, box] of boxOf) {
    const outs = lines.flatMap(({ edge, points }) =>
      points && edge.from === id ? [{ point: points[0]!, toward: points[1]![0] }] : [],
    );
    const ins = lines.flatMap(({ edge, points }) =>
      points && edge.to === id ? [{ point: points.at(-1)!, toward: points.at(-2)![0] }] : [],
    );
    spread(outs, box);
    spread(ins, box);
  }
  return lines.map(({ edge, points }) => {
    if (points) return { edge, d: curve(points), along: alongCurve(points), back: false };
    const [from, to] = [boxOf.get(edge.from)!, boxOf.get(edge.to)!];
    const [x0, y0, x1, y1] = [mid(from), from.y + from.h, mid(to), to.y + to.h];
    const d = `M${x0},${y0} C${x0},${y0 + BACK_BOW} ${x1},${y1 + BACK_BOW + HEAD_RUN} ${x1},${y1 + HEAD_RUN} L${x1},${y1}`;
    return { edge, d, along: bezier([x0, y0], [x0, y0 + BACK_BOW], [x1, y1 + BACK_BOW], [x1, y1]), back: true };
  });
}

type Point = { x: number; y: number };

/** The path `curve` draws, each segment an equal share of 0 to 1. */
function alongCurve(points: [number, number][]): (t: number) => Point {
  const n = points.length - 1;
  return (t) => {
    const i = Math.min(n - 1, Math.floor(t * n));
    const [[x0, y0], [x1, y1]] = [points[i]!, points[i + 1]!];
    const dy = (y1 - y0) / 2;
    return bezier([x0, y0], [x0, y0 + dy], [x1, y1 - dy], [x1, y1])(t * n - i);
  };
}

type Xy = [number, number];

function bezier(a: Xy, b: Xy, c: Xy, d: Xy): (t: number) => Point {
  return (t) => {
    const u = 1 - t;
    const at = (k: 0 | 1) => u ** 3 * a[k] + 3 * u * u * t * b[k] + 3 * u * t * t * c[k] + t ** 3 * d[k];
    return { x: at(0), y: at(1) };
  };
}

/**
 * Starts as close to `wanted` as order and spacing allow (least squares): pool adjacent violators
 * over each block's wanted start less the space the blocks before it need.
 */
function keepOrder(wanted: number[], space: number[]): number[] {
  const before = space.map((_, i) => space.slice(0, i).reduce((s, h) => s + h, 0));
  const pools: { sum: number; n: number }[] = [];
  for (let i = 0; i < wanted.length; i++) {
    pools.push({ sum: wanted[i]! - before[i]!, n: 1 });
    while (pools.length > 1) {
      const [a, b] = [pools.at(-2)!, pools.at(-1)!];
      if (a.sum / a.n <= b.sum / b.n) break;
      pools.splice(-2, 2, { sum: a.sum + b.sum, n: a.n + b.n });
    }
  }
  const shifts = pools.flatMap((p) => Array<number>(p.n).fill(p.sum / p.n));
  return shifts.map((z, i) => z + before[i]!);
}

/** The straight drop into the target box, at least the largest arrowhead's length. */
const HEAD_RUN = 12;

/**
 * A smooth path through `points`, vertical where it leaves and enters each one. It ends in a
 * straight drop, so the arrowhead sits on a straight stretch: a shallow curve that turned vertical
 * only within the head's length would leave its side.
 */
function curve(points: [number, number][]): string {
  let d = `M${points[0]![0]},${points[0]![1]}`;
  for (let i = 1; i < points.length; i++) {
    const [[x0, y0], [x1, end]] = [points[i - 1]!, points[i]!];
    const run = i === points.length - 1 ? Math.min(HEAD_RUN, (end - y0) / 3) : 0;
    const y1 = end - run;
    const dy = (y1 - y0) / 2;
    d += ` C${x0},${y0 + dy} ${x1},${y1 - dy} ${x1},${y1}`;
    if (run > 0) d += ` L${x1},${end}`;
  }
  return d;
}
