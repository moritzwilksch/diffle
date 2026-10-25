import { compareTreeOrder } from '@/client/model.js';
import type { GraphNode } from '@/shared/protocol.js';
import type { Graph, Ranked } from './rank.js';

/** One block of a layer: a file's symbols in that layer, a lone node, or a waypoint of a long edge. */
export interface Block {
  key: string;
  /** The file of a cluster; null for a lone node or a waypoint. */
  path: string | null;
  /** Node ids, or the waypoint's own id, top to bottom. */
  members: string[];
  waypoint: boolean;
}

/** A forward edge's way across the layers: its source, one waypoint per layer crossed, its target. */
export interface Route {
  from: string;
  to: string;
  stops: string[];
}

export interface Ordered {
  layers: Block[][];
  /** Every edge pointing to a later layer; the others run inside a cycle's layer. */
  routes: Route[];
}

const SWEEPS = 16;

/**
 * Source order, the graph's one order wherever it lists symbols: files as the diff and the tree
 * list them, then the definition line.
 */
export const bySource = (a: GraphNode, b: GraphNode) => compareTreeOrder(a.path, b.path) || a.line - b.line;

/**
 * Orders each layer to cut edge crossings: barycenter sweeps over its blocks, keeping the best
 * order seen. `clustered` groups a layer's symbols by file; a cluster keeps them in source order.
 */
export function order(graph: Graph, ranked: Ranked, clustered: boolean): Ordered {
  const layerOf = (id: string) => ranked.layer.get(id)!;
  const layers: Block[][] = Array.from({ length: ranked.layers }, () => []);
  const sorted = [...graph.nodes].sort(bySource);
  for (const n of sorted) {
    const layer = layers[layerOf(n.id)]!;
    const cluster = clustered ? layer.find((b) => b.path === n.path) : undefined;
    if (cluster) cluster.members.push(n.id);
    else layer.push({ key: `${n.path}#${n.id}`, path: clustered ? n.path : null, members: [n.id], waypoint: false });
  }
  const routes: Route[] = [];
  for (const e of graph.edges) {
    const [a, b] = [layerOf(e.from), layerOf(e.to)];
    if (b <= a) continue;
    const stops: string[] = [];
    for (let c = a + 1; c < b; c++) {
      const id = `${e.from}>${e.to}@${c}`;
      stops.push(id);
      layers[c]!.push({ key: id, path: null, members: [id], waypoint: true });
    }
    routes.push({ from: e.from, to: e.to, stops });
  }
  // Links between neighbouring layers, both ways.
  const left = new Map<string, string[]>();
  const right = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    right.set(a, [...(right.get(a) ?? []), b]);
    left.set(b, [...(left.get(b) ?? []), a]);
  };
  for (const r of routes) {
    const chain = [r.from, ...r.stops, r.to];
    for (let i = 1; i < chain.length; i++) link(chain[i - 1]!, chain[i]!);
  }

  let best = layers.map((c) => c.map((b) => ({ ...b, members: [...b.members] })));
  let fewest = crossings(layers, right);
  for (let sweep = 0; sweep < SWEEPS && fewest > 0; sweep++) {
    const down = sweep % 2 === 0;
    const indices = [...layers.keys()];
    for (const c of down ? indices.slice(1) : indices.reverse().slice(1)) {
      const neighbour = layers[down ? c - 1 : c + 1]!;
      reorder(layers[c]!, positions(neighbour), down ? left : right);
    }
    const count = crossings(layers, right);
    if (count < fewest) {
      fewest = count;
      best = layers.map((layer) => layer.map((b) => ({ ...b, members: [...b.members] })));
    }
  }
  return { layers: best, routes };
}

/** Each member's index from the start of its layer. */
function positions(layer: Block[]): Map<string, number> {
  return new Map(layer.flatMap((b) => b.members).map((id, i) => [id, i]));
}

function reorder(layer: Block[], fixed: Map<string, number>, links: Map<string, string[]>): void {
  const here = positions(layer);
  const barycenter = (id: string) => {
    const at = (links.get(id) ?? []).map((n) => fixed.get(n)).filter((p) => p != null);
    return at.length ? at.reduce((s, p) => s + p, 0) / at.length : here.get(id)!;
  };
  const score = new Map(layer.map((b) => [b, b.members.reduce((s, id) => s + barycenter(id), 0) / b.members.length]));
  layer.sort((x, y) => score.get(x)! - score.get(y)!);
}

/** Edge crossings between every pair of neighbouring layers. */
function crossings(layers: Block[][], right: Map<string, string[]>): number {
  let total = 0;
  for (let c = 0; c + 1 < layers.length; c++) {
    const [a, b] = [positions(layers[c]!), positions(layers[c + 1]!)];
    const segments = [...a].flatMap(([id, i]) => (right.get(id) ?? []).map((to) => [i, b.get(to)!] as const));
    for (let i = 0; i < segments.length; i++)
      for (let j = i + 1; j < segments.length; j++) {
        const [[a1, b1], [a2, b2]] = [segments[i]!, segments[j]!];
        if ((a1 - a2) * (b1 - b2) < 0) total++;
      }
  }
  return total;
}
