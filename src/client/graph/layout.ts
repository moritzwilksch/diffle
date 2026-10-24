import type { GraphEdge, GraphNode } from '@/shared/protocol.js';
import { type Block, order, type Route } from './order.js';
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

/** A file's symbols within one column. */
export interface PlacedCluster extends Box {
  path: string;
  column: number;
}

export interface PlacedEdge {
  edge: GraphEdge;
  /** SVG path data. */
  d: string;
  /** Runs inside a cycle, within one column. */
  back: boolean;
}

export interface Placed {
  nodes: PlacedNode[];
  clusters: PlacedCluster[];
  edges: PlacedEdge[];
  columns: { x: number; w: number }[];
  /** Top of the shelf below the columns holding the symbols with no links, when there are any. */
  shelf: number | null;
  width: number;
  height: number;
}

export const CLUSTER_HEADER = 26;
const CLUSTER_PAD = 8;
const NODE_GAP = 8;
const BLOCK_GAP = 22;
const COLUMN_GAP = 132;
const WAYPOINT_H = 4;
const RELAX_PASSES = 8;
/** How far a cycle's edge bows out into the gap right of its column. */
const BACK_BOW = 48;
/** Space between edge ends sharing one side of a box. */
const PORT_STEP = 7;
const SHELF_GAP = 72;
const SHELF_MIN_W = 960;

/**
 * Places a ranked graph: a column per rank, blocks stacked in the crossing-reduced order, each
 * block pulled toward the blocks it links to without changing the order or overlapping.
 */
export function layout(graph: Graph, ranked: Ranked, size: (n: GraphNode) => Size, clustered: boolean): Placed {
  // A symbol with no links has no rank to show; it waits on a shelf below instead of crowding the core column.
  const linked = new Set(graph.edges.flatMap((e) => [e.from, e.to]));
  const unlinked = graph.nodes.filter((n) => !linked.has(n.id));
  const { columns, routes } = order(
    { nodes: graph.nodes.filter((n) => linked.has(n.id)), edges: graph.edges },
    ranked,
    clustered,
  );
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const sizeOf = new Map(graph.nodes.map((n) => [n.id, size(n)]));
  const isCluster = (b: Block) => b.path != null;

  const columnBoxes: { x: number; w: number }[] = [];
  let x = 0;
  for (const column of columns) {
    const widest = Math.max(0, ...column.flatMap((b) => b.members.map((id) => sizeOf.get(id)?.w ?? 0)));
    const w = column.some(isCluster) ? widest + 2 * CLUSTER_PAD : widest;
    columnBoxes.push({ x, w });
    x += w + COLUMN_GAP;
  }

  // Each member's top relative to its block's top, and each block's height.
  const offset = new Map<string, number>();
  const height = new Map<Block, number>();
  for (const b of columns.flat()) {
    let y = isCluster(b) ? CLUSTER_HEADER : 0;
    for (const id of b.members) {
      offset.set(id, y);
      y += (sizeOf.get(id)?.h ?? WAYPOINT_H) + NODE_GAP;
    }
    height.set(b, y - NODE_GAP + (isCluster(b) ? CLUSTER_PAD : 0));
  }
  const memberH = (id: string) => sizeOf.get(id)?.h ?? WAYPOINT_H;

  const top = new Map<Block, number>();
  for (const column of columns) {
    let y = 0;
    for (const b of column) {
      top.set(b, y);
      y += height.get(b)! + BLOCK_GAP;
    }
  }
  const blockOf = new Map(columns.flat().flatMap((b) => b.members.map((id) => [id, b] as const)));
  const center = (id: string) => top.get(blockOf.get(id)!)! + offset.get(id)! + memberH(id) / 2;
  const neighbours = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    neighbours.set(a, [...(neighbours.get(a) ?? []), b]);
    neighbours.set(b, [...(neighbours.get(b) ?? []), a]);
  };
  for (const r of routes) {
    const chain = [r.from, ...r.stops, r.to];
    for (let i = 1; i < chain.length; i++) link(chain[i - 1]!, chain[i]!);
  }
  for (let pass = 0; pass < RELAX_PASSES; pass++) {
    for (const column of columns) {
      const wanted = column.map((b) => {
        const pulls = b.members.flatMap((id) =>
          (neighbours.get(id) ?? []).map((n) => center(n) - offset.get(id)! - memberH(id) / 2),
        );
        return pulls.length ? pulls.reduce((s, p) => s + p, 0) / pulls.length : top.get(b)!;
      });
      const placed = keepOrder(
        wanted,
        column.map((b) => height.get(b)! + BLOCK_GAP),
      );
      column.forEach((b, i) => top.set(b, placed[i]!));
    }
  }
  const minTop = Math.min(0, ...top.values());
  for (const [b, y] of top) top.set(b, y - minTop);

  const nodes: PlacedNode[] = [];
  const clusters: PlacedCluster[] = [];
  const boxOf = new Map<string, Box>();
  columns.forEach((column, c) => {
    const col = columnBoxes[c]!;
    for (const b of column) {
      if (b.waypoint) {
        boxOf.set(b.members[0]!, { x: col.x, y: top.get(b)!, w: col.w, h: WAYPOINT_H });
        continue;
      }
      if (b.path != null) clusters.push({ path: b.path, column: c, x: col.x, y: top.get(b)!, w: col.w, h: height.get(b)! });
      for (const id of b.members) {
        const s = sizeOf.get(id)!;
        const box = { x: col.x + (isCluster(b) ? CLUSTER_PAD : (col.w - s.w) / 2), y: top.get(b)! + offset.get(id)!, ...s };
        boxOf.set(id, box);
        nodes.push({ node: nodeById.get(id)!, ...box });
      }
    }
  });

  const edges = route(graph.edges, routes, boxOf);
  const width = Math.max(0, x - COLUMN_GAP);
  const columnsH = Math.max(0, ...[...top].map(([b, y]) => y + height.get(b)!));
  if (!unlinked.length) return { nodes, clusters, edges, columns: columnBoxes, shelf: null, width, height: columnsH };

  const shelf = linked.size ? columnsH + SHELF_GAP : 0;
  const shelfW = Math.max(width, SHELF_MIN_W);
  let [sx, sy, rowH] = [0, shelf, 0];
  const files = new Map<string, GraphNode[]>();
  for (const n of unlinked) {
    const key = clustered ? n.path : n.id;
    files.set(key, [...(files.get(key) ?? []), n]);
  }
  for (const [path, members] of files) {
    const inner = Math.max(...members.map((n) => sizeOf.get(n.id)!.w));
    const w = clustered ? inner + 2 * CLUSTER_PAD : inner;
    const h = clustered
      ? CLUSTER_HEADER + members.reduce((sum, n) => sum + sizeOf.get(n.id)!.h + NODE_GAP, 0) - NODE_GAP + CLUSTER_PAD
      : sizeOf.get(members[0]!.id)!.h;
    if (sx > 0 && sx + w > shelfW) [sx, sy, rowH] = [0, sy + rowH + BLOCK_GAP, 0];
    if (clustered) clusters.push({ path, column: -1, x: sx, y: sy, w, h });
    let ny = sy + (clustered ? CLUSTER_HEADER : 0);
    for (const node of members) {
      const s = sizeOf.get(node.id)!;
      nodes.push({ node, x: sx + (clustered ? CLUSTER_PAD : 0), y: ny, ...s });
      ny += s.h + NODE_GAP;
    }
    sx += w + BLOCK_GAP;
    rowH = Math.max(rowH, h);
  }
  return { nodes, clusters, edges, columns: columnBoxes, shelf, width: Math.max(width, sx), height: sy + rowH };
}

/**
 * Each edge as a path: level curves through its waypoints, or a bow for a cycle's edge. Edge ends
 * sharing a side of a box spread along it in the order of where they come from or go.
 */
function route(edges: GraphEdge[], routes: Route[], boxOf: Map<string, Box>): PlacedEdge[] {
  const routed = new Map(routes.map((r) => [`${r.from}>${r.to}`, r]));
  const mid = (b: Box): number => b.y + b.h / 2;
  const lines = edges.map((edge) => {
    const [from, to] = [boxOf.get(edge.from)!, boxOf.get(edge.to)!];
    const r = routed.get(`${edge.from}>${edge.to}`);
    if (!r) return { edge, points: null };
    const points: [number, number][] = [[from.x + from.w, mid(from)]];
    for (const stop of r.stops) {
      const b = boxOf.get(stop)!;
      points.push([b.x, mid(b)], [b.x + b.w, mid(b)]);
    }
    points.push([to.x, mid(to)]);
    return { edge, points };
  });
  const spread = (ends: { point: [number, number]; toward: number }[], box: Box) => {
    ends.sort((a, b) => a.toward - b.toward);
    const step = ends.length > 1 ? Math.min(PORT_STEP, (box.h * 0.6) / (ends.length - 1)) : 0;
    ends.forEach((end, i) => (end.point[1] = mid(box) + (i - (ends.length - 1) / 2) * step));
  };
  for (const [id, box] of boxOf) {
    const outs = lines.flatMap(({ edge, points }) =>
      points && edge.from === id ? [{ point: points[0]!, toward: points[1]![1] }] : [],
    );
    const ins = lines.flatMap(({ edge, points }) =>
      points && edge.to === id ? [{ point: points.at(-1)!, toward: points.at(-2)![1] }] : [],
    );
    spread(outs, box);
    spread(ins, box);
  }
  return lines.map(({ edge, points }) =>
    points
      ? { edge, d: curve(points), back: false }
      : { edge, d: bow(boxOf.get(edge.from)!, boxOf.get(edge.to)!), back: true },
  );
}

/**
 * Tops as close to `wanted` as order and spacing allow (least squares): pool adjacent violators
 * over each block's wanted top less the space the blocks above it need.
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

/** A smooth path through `points`, level where it leaves and enters each one. */
function curve(points: [number, number][]): string {
  let d = `M${points[0]![0]},${points[0]![1]}`;
  for (let i = 1; i < points.length; i++) {
    const [[x0, y0], [x1, y1]] = [points[i - 1]!, points[i]!];
    const dx = (x1 - x0) / 2;
    d += ` C${x0 + dx},${y0} ${x1 - dx},${y1} ${x1},${y1}`;
  }
  return d;
}

/** A cycle's edge between two boxes of one column, bowing out to the right. */
function bow(from: Box, to: Box): string {
  const [x0, y0, x1, y1] = [from.x + from.w, from.y + from.h / 2, to.x + to.w, to.y + to.h / 2];
  return `M${x0},${y0} C${x0 + BACK_BOW},${y0} ${x1 + BACK_BOW},${y1} ${x1},${y1}`;
}
