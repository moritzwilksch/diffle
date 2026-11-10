import { layout, type Placed, type PlacedNode, type Size } from '@/client/canvas/layout/layout.js';
import { rank } from '@/client/canvas/layout/rank.js';
import { sharedFolder } from '@/client/graph/labels.js';
import type { GraphEdge, GraphNode } from '@/shared/protocol.js';
import { bySource, type Graph } from './source.js';

/** One connected part of the graph, placed on its own. */
export interface Part {
  /** The id of its most-used node, which names it; stable while the graph is. */
  key: string;
  /** Its most-used node: what the part is "around". */
  hub: GraphNode;
  /**
   * In file view, the folder all its files share, which its header names and its boxes leave out of
   * their paths; '' for none, and always in symbol view.
   */
  folder: string;
  placed: Placed<GraphNode, GraphEdge>;
  /** Where the part sits in the stack; its header sits above this. */
  x: number;
  y: number;
}

export interface Stacked {
  parts: Part[];
  /** The symbols linked to nothing, laid out below the parts under their own header; null when there are none. */
  unlinked: { placed: Placed<GraphNode, GraphEdge>; y: number } | null;
  /** Every node at its place in the whole stack, for selection, keys and focus. */
  nodes: PlacedNode<GraphNode>[];
  width: number;
  height: number;
}

export const PART_HEADER = 40;
const PART_GAP = 72;

/**
 * Splits the graph into the parts linked to each other, largest first, and stacks them top to
 * bottom with the symbols linked to nothing last. Each part is ranked and laid out alone, so a
 * small part sits by itself instead of stretching across a big one's layers.
 */
export function stack(
  graph: Graph,
  size: (n: GraphNode, folder: string) => Size,
  clustered: boolean,
  only: string | null,
): Stacked {
  const all = split(graph);
  // Showing one part: the others and the unlinked symbols stand aside.
  const one = only == null ? undefined : all.parts.find((g) => hubOf(g).id === only);
  const groups = one ? [one] : all.parts;
  const unlinked = one ? { nodes: [], edges: [] } : all.unlinked;
  let y = 0;
  let width = 0;
  const parts = groups.map((g): Part => {
    const folder = clustered ? '' : sharedFolder(g.nodes.map((n) => n.path));
    const placed = place(g, (n) => size(n, folder), clustered);
    const part = { key: hubOf(g).id, hub: hubOf(g), folder, placed, x: 0, y: y + PART_HEADER };
    y += PART_HEADER + placed.height + PART_GAP;
    width = Math.max(width, placed.width);
    return part;
  });
  const nodes = parts.flatMap((p) => p.placed.nodes.map((n) => ({ ...n, x: n.x + p.x, y: n.y + p.y })));
  if (!unlinked.nodes.length) return { parts, unlinked: null, nodes, width, height: Math.max(0, y - PART_GAP) };
  // "No links" names no folder, so its boxes keep their whole paths.
  const placed = place(unlinked, (n) => size(n, ''), clustered);
  const top = y + PART_HEADER;
  nodes.push(...placed.nodes.map((n) => ({ ...n, y: n.y + top })));
  return {
    parts,
    unlinked: { placed, y: top },
    nodes,
    width: Math.max(width, placed.width),
    height: top + placed.height,
  };
}

/** `g` laid out in source order; in symbol view, a layer's symbols cluster by file. */
function place(g: Graph, size: (n: GraphNode) => Size, clustered: boolean): Placed<GraphNode, GraphEdge> {
  const nodes = [...g.nodes].sort(bySource);
  return layout({ nodes, edges: g.edges }, rank(g), { size, cluster: (n) => (clustered ? n.path : null) });
}

/** The weakly connected parts with at least one link, largest first, and the nodes with none. */
export function split(graph: Graph): { parts: Graph[]; unlinked: Graph } {
  const parent = new Map(graph.nodes.map((n) => [n.id, n.id]));
  const find = (id: string): string => {
    const p = parent.get(id)!;
    if (p === id) return id;
    const root = find(p);
    parent.set(id, root);
    return root;
  };
  for (const e of graph.edges) parent.set(find(e.from), find(e.to));
  const linked = new Set(graph.edges.flatMap((e) => [e.from, e.to]));
  const byRoot = new Map<string, Graph>();
  for (const n of graph.nodes.filter((n) => linked.has(n.id))) {
    const root = find(n.id);
    if (!byRoot.has(root)) byRoot.set(root, { nodes: [], edges: [] });
    byRoot.get(root)!.nodes.push(n);
  }
  for (const e of graph.edges) byRoot.get(find(e.from))!.edges.push(e);
  const parts = [...byRoot.values()].sort((a, b) => b.nodes.length - a.nodes.length || b.edges.length - a.edges.length);
  return { parts, unlinked: { nodes: graph.nodes.filter((n) => !linked.has(n.id)), edges: [] } };
}

/** The node most used within the part, a changed one before a consumer on a tie. */
function hubOf(g: Graph): GraphNode {
  const usedBy = new Map<string, number>();
  for (const e of g.edges) usedBy.set(e.to, (usedBy.get(e.to) ?? 0) + 1);
  const score = (n: GraphNode) => (usedBy.get(n.id) ?? 0) * 2 + (n.status === 'consumer' ? 0 : 1);
  return g.nodes.reduce((best, n) => (score(n) > score(best) ? n : best));
}
