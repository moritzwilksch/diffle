import { create } from 'zustand';
import { api } from '@/client/api.js';
import { useStore, type ViewPlace } from '@/client/store.js';
import { lspBlocker } from '@/shared/lsp.js';
import type { GraphEdge, GraphResponse, Snapshot } from '@/shared/protocol.js';
import { isTest, keepNodes } from './filters.js';
import { nodeSize } from './labels.js';
import { type Stacked, stack } from '@/client/graph/layout/components.js';
import type { PlacedNode } from '@/client/graph/layout/layout.js';
import { byFile, edgeKey } from '@/client/graph/layout/rank.js';

export type Filter = 'symbols' | 'consumers' | 'tests';
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
  view: View | null;
  /** The key of the one connected part shown alone, or null for every part. */
  only: string | null;
  selected: string | null;
  /** The selected arrow, by `edgeKey`; a node and an arrow are never selected together. */
  selectedEdge: string | null;
  /** The arrow of the details row under the pointer, by `edgeKey`: the canvas shows it on top. */
  hoveredEdge: string | null;
  /** A file the reader picked in the tree: its nodes stay lit and the view pans to them. */
  focusPath: string | null;
  /** The find field's text while it is open; its matches are `findMatches(view, find)`. */
  find: string | null;
  toggle(): void;
  close(): void;
  reload(): Promise<void>;
  /** Selects a node; selecting the selected one again clears it. */
  select(id: string | null): void;
  selectEdge(key: string | null): void;
  /** Clears the selected node or arrow and the file focused from the tree, so nothing stays lit. */
  deselect(): void;
  hoverEdge(key: string | null): void;
  /** Moves the selection to the nearest node that way: up / down across layers, left / right within one. */
  step(direction: Direction): void;
  /** Leaves the graph for the diff at `path:line`; Ctrl+o comes back to it as it was. */
  pick(target: { path: string; line: number }): Promise<void>;
  setFilter(filter: Filter, on: boolean): void;
  showOnly(part: string | null): void;
  openFind(): void;
  /** Searches for `query`, selecting its first match. */
  setFind(query: string): void;
  /** Selects the next match, or the previous one; both wrap around. */
  stepFind(by: 1 | -1): void;
  closeFind(): void;
}

/** The change graph view. It reads the review store and never the other way round. */
export const useGraph = create<GraphState>((set, get) => ({
  open: false,
  mounted: false,
  load: { state: 'idle' },
  snapshot: null,
  filters: { symbols: false, consumers: false, tests: false },
  view: null,
  selected: null,
  selectedEdge: null,
  hoveredEdge: null,
  focusPath: null,
  find: null,
  only: null,

  toggle() {
    if (get().open) return get().close();
    const review = useStore.getState();
    const blocked = lspBlocker(review.lsp, review.snapshot);
    if (blocked) return review.flash(blocked);
    show();
  },

  close() {
    set({ open: false, focusPath: null, hoveredEdge: null, find: null });
  },

  async reload() {
    const snapshot = useStore.getState().snapshot;
    set({ load: { state: 'loading' }, snapshot });
    // A newer snapshot, or a newer reload, owns the result.
    const current = () => useStore.getState().snapshot === snapshot && get().snapshot === snapshot;
    try {
      const graph = await api.lspGraph();
      if (!current()) return;
      const view = derive(graph, get().filters, get().only);
      const selected = view.graph.nodes.some((n) => n.id === get().selected) ? get().selected : null;
      set({ load: { state: 'ready', graph }, view, selected, selectedEdge: keptEdge(view, get().selectedEdge) });
    } catch (e) {
      if (current()) set({ load: { state: 'error', message: e instanceof Error ? e.message : String(e) }, view: null });
    }
  },

  select(id) {
    set({ selected: id === get().selected ? null : id, selectedEdge: null, hoveredEdge: null, focusPath: null });
  },

  hoverEdge(key) {
    set({ hoveredEdge: key });
  },

  deselect() {
    set({ selected: null, selectedEdge: null, hoveredEdge: null, focusPath: null });
  },

  selectEdge(key) {
    set({ selectedEdge: key === get().selectedEdge ? null : key, selected: null, hoveredEdge: null, focusPath: null });
  },

  step(direction) {
    const nodes = get().view?.stacked.nodes ?? [];
    const from = nodes.find((p) => p.node.id === get().selected);
    if (!from) return set({ selected: nearestToOrigin(nodes)?.node.id ?? null, selectedEdge: null, focusPath: null });
    const next = nearest(from, nodes, direction);
    if (next) set({ selected: next.node.id, selectedEdge: null, focusPath: null });
  },

  async pick({ path, line }) {
    // Closed only once the jump is made: the jump list records the graph as the place left.
    await useStore.getState().goToLink(path, line);
    get().close();
  },

  setFilter(filter, on) {
    const filters = { ...get().filters, [filter]: on };
    const load = get().load;
    const view = load.state === 'ready' ? derive(load.graph, filters, get().only) : null;
    const selected = view?.graph.nodes.some((n) => n.id === get().selected) ? get().selected : null;
    set({ filters, view, selected, selectedEdge: view && keptEdge(view, get().selectedEdge) });
  },

  showOnly(part) {
    const load = get().load;
    if (load.state !== 'ready') return;
    set({ only: part, view: derive(load.graph, get().filters, part) });
  },

  openFind() {
    if (get().find == null) set({ find: '' });
  },

  setFind(query) {
    const first = findMatches(get().view, query)[0];
    set({ find: query, ...(first ? { selected: first, selectedEdge: null, focusPath: null } : {}) });
  },

  stepFind(by) {
    const matches = findMatches(get().view, get().find);
    if (!matches.length) return;
    const at = matches.indexOf(get().selected ?? '');
    // Off the matches, the first step lands on the first or the last one.
    const next = matches[at < 0 ? (by > 0 ? 0 : matches.length - 1) : (at + by + matches.length) % matches.length]!;
    set({ selected: next, selectedEdge: null, focusPath: null });
  },

  closeFind() {
    set({ find: null });
  },
}));

/**
 * The nodes whose name holds `query`, ignoring case (a file by its path), in reading order: top to
 * bottom, then left to right. None for an empty query.
 */
export function findMatches(view: View | null, query: string | null): string[] {
  const q = query?.trim().toLowerCase();
  if (!view || !q) return [];
  return view.stacked.nodes
    .filter((p) => (p.node.kind === 1 ? p.node.path : p.node.name).toLowerCase().includes(q))
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((p) => p.node.id);
}

let watching = false;

/** Shows the graph over the diff, refetching it when the review moved on since it was loaded. */
function show(): void {
  followReview();
  useGraph.setState({ open: true, mounted: true, focusPath: null });
  const graph = useGraph.getState();
  if (graph.snapshot !== useStore.getState().snapshot || graph.load.state === 'idle') void graph.reload();
}

/**
 * The graph as it stands, for the jump list: Ctrl+o after a jump into the diff restores it, and
 * one selection to another within the graph steps between them.
 */
function place(): ViewPlace {
  const { selected, selectedEdge, filters, only } = useGraph.getState();
  return {
    view: `graph:${selected ?? selectedEdge ?? ''}`,
    restore() {
      const graph = useGraph.getState();
      const load = graph.load;
      const changed = filters !== graph.filters || only !== graph.only;
      const view = changed && load.state === 'ready' ? derive(load.graph, filters, only) : graph.view;
      useGraph.setState({ filters, only, view, selected, selectedEdge });
      show();
    },
  };
}

/**
 * Starts following the review, once, when the graph first opens: a new snapshot refreshes an open
 * graph (a closed one is refetched when it next opens), a file picked in the tree while the graph
 * is open becomes its focus, and the graph takes part in the jump list.
 */
function followReview(): void {
  if (watching) return;
  watching = true;
  useStore.getState().registerView({
    here: () => (useGraph.getState().open ? place() : null),
    leave: () => useGraph.getState().close(),
  });
  useStore.subscribe((s, prev) => {
    const graph = useGraph.getState();
    if (s.snapshot !== prev.snapshot && graph.open) void graph.reload();
    if (s.activePath !== prev.activePath && s.activePath && graph.open)
      useGraph.setState({ focusPath: s.activePath, selected: null, selectedEdge: null });
  });
}

/**
 * The graph as shown: filtered, folded into files in file view, stacked into parts. `symbols` is
 * the symbol graph under it and `via` the symbol edges behind each shown edge, for labels and the
 * details of a selected arrow.
 */
export interface View {
  graph: GraphResponse;
  symbols: GraphResponse;
  via: Map<string, GraphEdge[]>;
  stacked: Stacked;
}

function derive(graph: GraphResponse, filters: Record<Filter, boolean>, only: string | null): View {
  const symbols = keepNodes(
    graph,
    (n) => (filters.consumers || n.status !== 'consumer') && (filters.tests || !isTest(n)),
  );
  const { graph: shown, via } = filters.symbols
    ? { graph: symbols, via: new Map(symbols.edges.map((e) => [edgeKey(e), [e]])) }
    : byFile(symbols);
  return {
    graph: shown,
    symbols,
    via,
    stacked: stack(shown, (n) => nodeSize(n, filters.symbols), filters.symbols, only),
  };
}

const keptEdge = (view: View, key: string | null) => (key && view.via.has(key) ? key : null);

const centerOf = (p: PlacedNode) => ({ x: p.x + p.w / 2, y: p.y + p.h / 2 });

function nearestToOrigin(nodes: PlacedNode[]): PlacedNode | undefined {
  return [...nodes].sort((a, b) => a.y - b.y || a.x - b.x)[0];
}

/** The closest node strictly that way; across layers, sideways distance counts less than the layer gap. */
function nearest(from: PlacedNode, nodes: PlacedNode[], direction: Direction): PlacedNode | undefined {
  const a = centerOf(from);
  const sameLayer = (p: PlacedNode) => p.y < from.y + from.h && from.y < p.y + p.h;
  const ahead = nodes.filter((p) => {
    if (p === from) return false;
    const b = centerOf(p);
    if (direction === 'up') return b.y < from.y;
    if (direction === 'down') return b.y > from.y + from.h;
    if (!sameLayer(p)) return false;
    return direction === 'left' ? b.x < a.x : b.x > a.x;
  });
  const cost = (p: PlacedNode) => {
    const b = centerOf(p);
    return direction === 'up' || direction === 'down'
      ? Math.abs(b.y - a.y) + 2 * Math.abs(b.x - a.x)
      : Math.abs(b.x - a.x);
  };
  return ahead.sort((p, q) => cost(p) - cost(q))[0];
}
