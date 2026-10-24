import type { GraphResponse } from '@/shared/protocol.js';
import type { ReviewState } from '@/client/store.js';
import { canListContext, clusterAt, type Focus } from './focus.js';

type Action = (s: ReviewState) => unknown;

// The cluster chords act only where the clusters are listed; elsewhere they are free keys that do nothing.
const inConnected = (s: ReviewState) => s.treeScope === 'connected';

/** Whether the graph dialog has a cluster to draw: the focus is a cluster the loaded graph holds. */
export function canOpenGraph(graph: GraphResponse | null, focus: Focus | null): boolean {
  return focus?.kind === 'cluster' && !!graph?.clusters.some((c) => c.id === focus.id);
}

/**
 * `gt` / `gT` step the focused group, `gc` toggles the unchanged callers, `gm` opens the cluster's graph,
 * `gC` enters and leaves Connected.
 */
export const CONNECTED_KEYS: Record<string, Action> = {
  gt: (s) => inConnected(s) && s.moveCluster(1),
  gT: (s) => inConnected(s) && s.moveCluster(-1),
  // With nothing to list the toggle is disabled, so its key is too: it would only flip a flag nothing shows.
  gc: (s) => inConnected(s) && canListContext(s.graph.data, s.focus) && s.toggleContext(),
  gm: (s) => inConnected(s) && canOpenGraph(s.graph.data, s.focus) && s.setGraphOpen(true),
  gC: (s) => s.setTreeScope(inConnected(s) ? s.connectedFrom : 'connected'),
};

/**
 * `{n}gt` jumps to cluster n (a count past the last one lands on the last); `{n}gT` steps n groups back.
 * Without a count the chords above step by one.
 */
export const CONNECTED_COUNTED: Record<string, (s: ReviewState, count: number) => unknown> = {
  gt: (s, n) => {
    const target = inConnected(s) ? clusterAt(s.graph.data, n) : null;
    if (target) s.focusCluster(target);
  },
  gT: (s, n) => inConnected(s) && s.moveCluster(-n),
};
