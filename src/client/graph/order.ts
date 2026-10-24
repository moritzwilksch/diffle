import type { Graph, Ranked } from './rank.js';

/** One block of a column: a file's symbols in that column, a lone node, or a waypoint of a long edge. */
export interface Block {
  key: string;
  /** The file of a cluster; null for a lone node or a waypoint. */
  path: string | null;
  /** Node ids, or the waypoint's own id, top to bottom. */
  members: string[];
  waypoint: boolean;
}

/** A forward edge's way across the columns: its source, one waypoint per column crossed, its target. */
export interface Route {
  from: string;
  to: string;
  stops: string[];
}

export interface Ordered {
  columns: Block[][];
  /** Every edge pointing to a later column; the others run inside a cycle's column. */
  routes: Route[];
}

const SWEEPS = 16;

/**
 * Orders each column to cut edge crossings: barycenter sweeps over blocks, then over the symbols
 * inside each cluster, keeping the best order seen. `clustered` groups a column's symbols by file.
 */
export function order(graph: Graph, ranked: Ranked, clustered: boolean): Ordered {
  const columnOf = (id: string) => ranked.column.get(id)!;
  const columns: Block[][] = Array.from({ length: ranked.columns }, () => []);
  const sorted = [...graph.nodes].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  for (const n of sorted) {
    const column = columns[columnOf(n.id)]!;
    const cluster = clustered ? column.find((b) => b.path === n.path) : undefined;
    if (cluster) cluster.members.push(n.id);
    else column.push({ key: `${n.path}#${n.id}`, path: clustered ? n.path : null, members: [n.id], waypoint: false });
  }
  const routes: Route[] = [];
  for (const e of graph.edges) {
    const [a, b] = [columnOf(e.from), columnOf(e.to)];
    if (b <= a) continue;
    const stops: string[] = [];
    for (let c = a + 1; c < b; c++) {
      const id = `${e.from}>${e.to}@${c}`;
      stops.push(id);
      columns[c]!.push({ key: id, path: null, members: [id], waypoint: true });
    }
    routes.push({ from: e.from, to: e.to, stops });
  }
  // Links between neighbouring columns, both ways.
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

  let best = columns.map((c) => c.map((b) => ({ ...b, members: [...b.members] })));
  let fewest = crossings(columns, right);
  for (let sweep = 0; sweep < SWEEPS && fewest > 0; sweep++) {
    const down = sweep % 2 === 0;
    const indices = [...columns.keys()];
    for (const c of down ? indices.slice(1) : indices.reverse().slice(1)) {
      const neighbour = columns[down ? c - 1 : c + 1]!;
      reorder(columns[c]!, positions(neighbour), down ? left : right);
    }
    const count = crossings(columns, right);
    if (count < fewest) {
      fewest = count;
      best = columns.map((col) => col.map((b) => ({ ...b, members: [...b.members] })));
    }
  }
  return { columns: best, routes };
}

/** Each member's index from the top of its column. */
function positions(column: Block[]): Map<string, number> {
  return new Map(column.flatMap((b) => b.members).map((id, i) => [id, i]));
}

function reorder(column: Block[], fixed: Map<string, number>, links: Map<string, string[]>): void {
  const here = positions(column);
  const barycenter = (id: string) => {
    const at = (links.get(id) ?? []).map((n) => fixed.get(n)).filter((p) => p != null);
    return at.length ? at.reduce((s, p) => s + p, 0) / at.length : here.get(id)!;
  };
  for (const b of column) {
    const score = new Map(b.members.map((id) => [id, barycenter(id)]));
    b.members.sort((x, y) => score.get(x)! - score.get(y)!);
  }
  const score = new Map(column.map((b) => [b, b.members.reduce((s, id) => s + barycenter(id), 0) / b.members.length]));
  column.sort((x, y) => score.get(x)! - score.get(y)!);
}

/** Edge crossings between every pair of neighbouring columns. */
function crossings(columns: Block[][], right: Map<string, string[]>): number {
  let total = 0;
  for (let c = 0; c + 1 < columns.length; c++) {
    const [a, b] = [positions(columns[c]!), positions(columns[c + 1]!)];
    const segments = [...a].flatMap(([id, i]) => (right.get(id) ?? []).map((to) => [i, b.get(to)!] as const));
    for (let i = 0; i < segments.length; i++)
      for (let j = i + 1; j < segments.length; j++) {
        const [[a1, b1], [a2, b2]] = [segments[i]!, segments[j]!];
        if ((a1 - a2) * (b1 - b2) < 0) total++;
      }
  }
  return total;
}
