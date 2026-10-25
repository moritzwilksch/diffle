import type { GraphNode, GraphResponse } from '@/shared/protocol.js';
import { isTest } from './filters.js';
import { basename } from './labels.js';

/** What decides whether a file has boxes in the graph as shown. */
export interface Shown {
  /** Paths with a box on the canvas. */
  drawn: Set<string>;
  graph: GraphResponse | null;
  filters: { consumers: boolean; tests: boolean };
  scope: string | null;
}

/**
 * Why `path` has no box on the canvas, in words to flash; `only` when another part shown alone hides
 * it, which the caller undoes; null when it has one, or while nothing is loaded to tell.
 */
export function hiddenReason({ drawn, graph, filters, scope }: Shown, path: string): string | null {
  if (drawn.has(path) || !graph) return null;
  const name = basename(path);
  const nodes = graph.nodes.filter((n) => n.path === path);
  if (nodes.length) {
    const hiddenBy = (n: GraphNode) =>
      !filters.tests && isTest(n) ? 'tests' : !filters.consumers && n.status === 'consumer' ? 'consumers' : null;
    const reasons = nodes.map(hiddenBy);
    if (reasons.includes(null)) return 'only';
    return reasons.includes('tests')
      ? `${name} is test code, and tests are hidden: T shows them`
      : `${name} only uses the change, and dependents are hidden: d shows them`;
  }
  if (graph.cut.some((n) => n.path === path)) return `${name} did not fit in the graph: see Not in the graph`;
  if (scope && !path.startsWith(`${scope}/`)) return `${name} is outside ${scope}/, the folder the graph shows`;
  return `${name} has no changed function, class or type, and uses none`;
}
