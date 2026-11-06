import { create } from 'zustand';
import { api } from '@/client/api.js';
import { useStore, type ViewPlace } from '@/client/store.js';
import { showView, useViews } from '@/client/views/state.js';
import type { GraphEdge, GraphResponse, Snapshot } from '@/shared/protocol.js';
import { isTest, keepNodes } from './filters.js';
import { hiddenReason } from './focus.js';
import { nodeSize } from './labels.js';
import { type Stacked, stack } from '@/client/graph/layout/components.js';
import { type Direction, nearest, nearestToOrigin } from '@/client/graph/layout/nearest.js';
import { byFile, edgeKey } from '@/client/graph/layout/rank.js';

export type Filter = 'symbols' | 'consumers' | 'tests';
export type { Direction };

type Load =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; graph: GraphResponse };

export interface GraphState {
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
  /** A file the reader picked in the tree: its boxes are highlighted and the view frames them. */
  focusPath: string | null;
  /** Counts the picks, so picking the same file again frames it again. */
  focusSeq: number;
  /** Draw every changed symbol, past the server's cap. */
  all: boolean;
  /** A folder picked in the tree: only the changes under it are graphed. */
  scope: string | null;
  /** The find field's text while it is open; its matches are `findMatches(view, find)`. */
  find: string | null;
  reload(): Promise<void>;
  /** Selects a node, or clears the selection with null. */
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
  /** Highlights and frames the boxes of `path`, a file picked in the tree, or says why it has none. */
  focusFile(path: string): void;
  /** Reloads the graph with every changed symbol the cap left out. */
  showAll(): void;
  /** Shows the graph of only the changes under `dir`, or of all of them again for null. */
  showScope(dir: string | null): void;
  openFind(): void;
  /** Searches for `query`, selecting its first match. */
  setFind(query: string): void;
  /** Selects the next match, or the previous one; both wrap around. */
  stepFind(by: 1 | -1): void;
  closeFind(): void;
}

/** The change graph view. It reads the review store and never the other way round. */
export const useGraph = create<GraphState>((set, get) => ({
  load: { state: 'idle' },
  snapshot: null,
  filters: { symbols: false, consumers: false, tests: false },
  view: null,
  selected: null,
  selectedEdge: null,
  hoveredEdge: null,
  focusPath: null,
  focusSeq: 0,
  find: null,
  only: null,
  all: false,
  scope: null,

  async reload() {
    const snapshot = useStore.getState().snapshot;
    const generation = ++loads;
    set({ load: { state: 'loading' }, snapshot });
    // A newer snapshot, or a newer reload, owns the result.
    const current = () => generation === loads && useStore.getState().snapshot === snapshot;
    try {
      const { all, scope } = get();
      const graph = await api.lspGraph({ ...(all ? { all: '1' } : {}), ...(scope ? { scope } : {}) });
      if (!current()) return;
      const view = derive(graph, get().filters, get().only);
      set({ load: { state: 'ready', graph }, view, ...keptSelection(view) });
    } catch (e) {
      if (current()) set({ load: { state: 'error', message: e instanceof Error ? e.message : String(e) }, view: null });
    }
  },

  select(id) {
    set({ selected: id, selectedEdge: null, hoveredEdge: null, focusPath: null });
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
    // The jump moves the active file while the graph still shows; that is no tree pick to focus.
    picking = true;
    try {
      await useStore.getState().goToLink(path, line);
    } finally {
      picking = false;
    }
    showView('diff');
  },

  setFilter(filter, on) {
    const filters = { ...get().filters, [filter]: on };
    const load = get().load;
    const view = load.state === 'ready' ? derive(load.graph, filters, get().only) : null;
    set({ filters, view, ...(view ? keptSelection(view) : { selected: null, selectedEdge: null }) });
  },

  showOnly(part) {
    const load = get().load;
    if (load.state !== 'ready') return;
    const view = derive(load.graph, get().filters, part);
    set({ only: part, view, ...keptSelection(view) });
  },

  focusFile(path) {
    const { view, load, filters, scope } = get();
    const drawn = new Set(view?.stacked.nodes.map((p) => p.node.path));
    const why = hiddenReason({ drawn, graph: load.state === 'ready' ? load.graph : null, filters, scope }, path);
    if (why === 'only') get().showOnly(null);
    else if (why) useStore.getState().flash(why);
    set({ focusPath: path, focusSeq: get().focusSeq + 1, selected: null, selectedEdge: null });
  },

  showAll() {
    set({ all: true });
    void get().reload();
  },

  showScope(scope) {
    // A cleared snapshot makes opening the graph load it afresh, once.
    set({ scope, all: false, selected: null, selectedEdge: null, focusPath: null, snapshot: null });
    if (shown()) void get().reload();
    else showView('graph');
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
/** Counts reloads: only the latest one commits its result. */
let loads = 0;
/** Set while `pick` jumps into the diff, so the file it lands on does not clear the graph's selection. */
let picking = false;

const shown = () => useViews.getState().active === 'graph';

/** The graph is shown: it refetches when the review moved on since it was loaded. */
export function enterGraph(): void {
  followReview();
  useGraph.setState({ focusPath: null });
  const graph = useGraph.getState();
  if (graph.snapshot !== useStore.getState().snapshot || graph.load.state === 'idle') void graph.reload();
}

export function leaveGraph(): void {
  useGraph.setState({ focusPath: null, hoveredEdge: null, find: null });
}

/**
 * The graph as it stands, for the jump list: Ctrl+o after a jump into the diff restores it, and
 * one selection to another within the graph steps between them.
 */
export function graphPlace(): ViewPlace {
  const { selected, selectedEdge, filters, only } = useGraph.getState();
  return {
    view: `graph:${selected ?? selectedEdge ?? ''}`,
    restore() {
      const graph = useGraph.getState();
      const load = graph.load;
      const changed = filters !== graph.filters || only !== graph.only;
      const view = changed && load.state === 'ready' ? derive(load.graph, filters, only) : graph.view;
      useGraph.setState({ filters, only, view, selected, selectedEdge });
      showView('graph');
    },
  };
}

/**
 * Starts following the review, once, when the graph is first shown: a new snapshot refreshes a shown
 * graph (a hidden one is refetched when it next shows), and a file picked in the tree while the graph
 * shows becomes its focus.
 */
function followReview(): void {
  if (watching) return;
  watching = true;
  useStore.subscribe((s, prev) => {
    const graph = useGraph.getState();
    if (s.snapshot !== prev.snapshot && shown()) void graph.reload();
    if (s.activePath !== prev.activePath && s.activePath && shown() && !picking) graph.focusFile(s.activePath);
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

/** The selected node or arrow while `view` still draws it, else none: a filter or a part shown alone may hide it. */
function keptSelection(view: View): Pick<GraphState, 'selected' | 'selectedEdge'> {
  const drawn = new Set(view.stacked.nodes.map((p) => p.node.id));
  const { selected, selectedEdge } = useGraph.getState();
  const edgeDrawn =
    selectedEdge != null && view.via.has(selectedEdge) && selectedEdge.split('\0').every((id) => drawn.has(id));
  return {
    selected: selected != null && drawn.has(selected) ? selected : null,
    selectedEdge: edgeDrawn ? selectedEdge : null,
  };
}
