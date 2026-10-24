import { create } from 'zustand';
import { api } from '@/client/api.js';
import { useStore } from '@/client/store.js';
import { lspBlocker } from '@/shared/lsp.js';
import type { GraphResponse, Snapshot } from '@/shared/protocol.js';
import { isTest, keepNodes } from './filters.js';
import { nodeSize } from './labels.js';
import { layout, type Placed, type PlacedNode } from './layout.js';
import { byFile, rank } from './rank.js';

export type Filter = 'files' | 'consumers' | 'tests';
export type Direction = 'left' | 'right' | 'up' | 'down';

type Load =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; graph: GraphResponse };

export interface GraphState {
  /** The graph covers the diff. */
  open: boolean;
  /** Opened at least once: the view stays mounted under the diff, so its pan and zoom survive a switch. */
  mounted: boolean;
  load: Load;
  /** The snapshot `load` answers for; another current snapshot makes it stale. */
  snapshot: Snapshot | null;
  filters: Record<Filter, boolean>;
  /** The loaded graph, filtered and laid out. */
  view: { graph: GraphResponse; placed: Placed } | null;
  selected: string | null;
  /** A file the reader picked in the tree: its nodes stay lit and the view pans to them. */
  focusPath: string | null;
  toggle(): void;
  close(): void;
  reload(): Promise<void>;
  select(id: string | null): void;
  /** Moves the selection to the nearest node that way: left / right across columns, up / down within one. */
  step(direction: Direction): void;
  /** Leaves the graph for the diff at `path:line`. */
  pick(target: { path: string; line: number }): void;
  setFilter(filter: Filter, on: boolean): void;
}

/** The change graph view. It reads the review store and never the other way round. */
export const useGraph = create<GraphState>((set, get) => ({
  open: false,
  mounted: false,
  load: { state: 'idle' },
  snapshot: null,
  filters: { files: false, consumers: true, tests: false },
  view: null,
  selected: null,
  focusPath: null,

  toggle() {
    if (get().open) return get().close();
    const review = useStore.getState();
    const blocked = lspBlocker(review.lsp, review.snapshot);
    if (blocked) return review.flash(blocked);
    followReview();
    set({ open: true, mounted: true, focusPath: null });
    if (get().snapshot !== review.snapshot || get().load.state === 'idle') void get().reload();
  },

  close() {
    set({ open: false, focusPath: null });
  },

  async reload() {
    const snapshot = useStore.getState().snapshot;
    set({ load: { state: 'loading' }, snapshot });
    // A newer snapshot, or a newer reload, owns the result.
    const current = () => useStore.getState().snapshot === snapshot && get().snapshot === snapshot;
    try {
      const graph = await api.lspGraph();
      if (!current()) return;
      const view = derive(graph, get().filters);
      const selected = view.graph.nodes.some((n) => n.id === get().selected) ? get().selected : null;
      set({ load: { state: 'ready', graph }, view, selected });
    } catch (e) {
      if (current()) set({ load: { state: 'error', message: e instanceof Error ? e.message : String(e) }, view: null });
    }
  },

  select(id) {
    set({ selected: id, focusPath: null });
  },

  step(direction) {
    const nodes = get().view?.placed.nodes ?? [];
    const from = nodes.find((p) => p.node.id === get().selected);
    if (!from) return set({ selected: nearestToOrigin(nodes)?.node.id ?? null, focusPath: null });
    const next = nearest(from, nodes, direction);
    if (next) set({ selected: next.node.id, focusPath: null });
  },

  pick({ path, line }) {
    get().close();
    void useStore.getState().goToLink(path, line);
  },

  setFilter(filter, on) {
    const filters = { ...get().filters, [filter]: on };
    const load = get().load;
    const view = load.state === 'ready' ? derive(load.graph, filters) : null;
    const selected = view?.graph.nodes.some((n) => n.id === get().selected) ? get().selected : null;
    set({ filters, view, selected });
  },
}));

let watching = false;

/**
 * Starts following the review, once, when the graph first opens: a new snapshot refreshes an open
 * graph (a closed one is refetched when it next opens), and a file picked in the tree while the
 * graph is open becomes its focus.
 */
function followReview(): void {
  if (watching) return;
  watching = true;
  useStore.subscribe((s, prev) => {
    const graph = useGraph.getState();
    if (s.snapshot !== prev.snapshot && graph.open) void graph.reload();
    if (s.activePath !== prev.activePath && s.activePath && graph.open)
      useGraph.setState({ focusPath: s.activePath, selected: null });
  });
}

function derive(graph: GraphResponse, filters: Record<Filter, boolean>): GraphState['view'] & {} {
  const kept = keepNodes(graph, (n) => (filters.consumers || n.status !== 'consumer') && (filters.tests || !isTest(n)));
  const shown = filters.files ? byFile(kept) : kept;
  return { graph: shown, placed: layout(shown, rank(shown), (n) => nodeSize(n, !filters.files), !filters.files) };
}

const centerOf = (p: PlacedNode) => ({ x: p.x + p.w / 2, y: p.y + p.h / 2 });

function nearestToOrigin(nodes: PlacedNode[]): PlacedNode | undefined {
  return [...nodes].sort((a, b) => a.x - b.x || a.y - b.y)[0];
}

/** The closest node strictly that way; across columns, vertical distance counts less than the column gap. */
function nearest(from: PlacedNode, nodes: PlacedNode[], direction: Direction): PlacedNode | undefined {
  const a = centerOf(from);
  const sameColumn = (p: PlacedNode) => p.x < from.x + from.w && from.x < p.x + p.w;
  const ahead = nodes.filter((p) => {
    if (p === from) return false;
    const b = centerOf(p);
    if (direction === 'left') return b.x < from.x;
    if (direction === 'right') return b.x > from.x + from.w;
    if (!sameColumn(p)) return false;
    return direction === 'up' ? b.y < a.y : b.y > a.y;
  });
  const cost = (p: PlacedNode) => {
    const b = centerOf(p);
    return direction === 'left' || direction === 'right'
      ? Math.abs(b.x - a.x) + 2 * Math.abs(b.y - a.y)
      : Math.abs(b.y - a.y);
  };
  return ahead.sort((p, q) => cost(p) - cost(q))[0];
}
