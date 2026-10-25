import type { GraphNode } from '@/shared/protocol.js';
import type { Graph } from '@/client/graph/layout/rank.js';

/** The graph limited to the nodes `keep` accepts and the edges between them. */
export function keepNodes<G extends Graph>(graph: G, keep: (n: GraphNode) => boolean): G {
  const nodes = graph.nodes.filter(keep);
  const ids = new Set(nodes.map((n) => n.id));
  return { ...graph, nodes, edges: graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
}

// Test code by the conventions of most ecosystems: a test directory, a test file name, or Rust's
// inline `mod tests`. A path convention, not a parse: the servers do not say what a test is.
const TEST_DIR = /(^|\/)(tests?|__tests__|spec|specs|e2e)\//;
const TEST_FILE = /(^|\/)(test_[^/]*|[^/]*_test\.[^/.]+|[^/]*\.(test|spec)\.[^/]+)$/;

export function isTest(node: GraphNode): boolean {
  return TEST_DIR.test(node.path) || TEST_FILE.test(node.path) || node.container === 'tests';
}
