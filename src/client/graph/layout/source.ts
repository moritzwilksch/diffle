import { edgeKey } from '@/client/canvas/layout/rank.js';
import { compareTreeOrder } from '@/client/model.js';
import type { GraphEdge, GraphNode, GraphNodeStatus, GraphResponse } from '@/shared/protocol.js';

export type Graph = Pick<GraphResponse, 'nodes' | 'edges'>;

/**
 * Source order, the graph's one order wherever it lists symbols: files as the diff and the tree
 * list them, then the definition line.
 */
export const bySource = (a: GraphNode, b: GraphNode) => compareTreeOrder(a.path, b.path) || a.line - b.line;

/**
 * The same graph with one node per file: changed when any symbol in it changed, edges merged.
 * `via` keeps, per file edge, the symbol edges behind it.
 */
export function byFile(graph: GraphResponse): { graph: GraphResponse; via: Map<string, GraphEdge[]> } {
  const files = new Map<string, GraphNode[]>();
  for (const n of graph.nodes) files.set(n.path, [...(files.get(n.path) ?? []), n]);
  const nodes = [...files].map(([path, members]): GraphNode => {
    const more = members.reduce((sum, n) => sum + (n.moreConsumers ?? 0), 0);
    return {
      id: path,
      name: path,
      kind: 1,
      path,
      line: 1,
      startLine: 1,
      endLine: 1,
      col: 0,
      status: fileStatus(members.map((n) => n.status)),
      ...(more ? { moreConsumers: more } : {}),
    };
  });
  const pathOf = new Map(graph.nodes.map((n) => [n.id, n.path]));
  const edges = new Map<string, GraphEdge>();
  const via = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    const [from, to] = [pathOf.get(e.from)!, pathOf.get(e.to)!];
    if (from === to) continue;
    const key = edgeKey({ from, to });
    const lines = new Set([...(edges.get(key)?.lines ?? []), ...e.lines]);
    edges.set(key, { from, to, lines: [...lines].sort((a, b) => a - b) });
    via.set(key, [...(via.get(key) ?? []), e]);
  }
  return { graph: { ...graph, nodes, edges: [...edges.values()] }, via };
}

function fileStatus(statuses: GraphNodeStatus[]): GraphNodeStatus {
  const changed = statuses.filter((s) => s !== 'consumer');
  if (!changed.length) return 'consumer';
  return changed.every((s) => s === 'added') ? 'added' : 'modified';
}
