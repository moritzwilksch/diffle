import { FlaskConical, FolderOpen, LayersArrowUp, LoaderCircle, RefreshCw, SquareFunction, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button, TOGGLE_ON } from '@/client/ui/Button.js';
import { useStore } from '@/client/store.js';
import { GraphCanvas } from './GraphCanvas.js';
import { type Filter, useGraph } from './state.js';

/** The change graph in the diff's place: what it holds, the view filters, and the canvas. */
export function GraphView() {
  const load = useGraph((s) => s.load);
  const view = useGraph((s) => s.view);
  const filters = useGraph((s) => s.filters);
  const scope = useGraph((s) => s.scope);
  const graph = view?.graph;
  const changed = graph?.nodes.filter((n) => n.status !== 'consumer').length ?? 0;
  const full = load.state === 'ready' ? load.graph : null;
  const loading = load.state === 'loading';
  return (
    <section className="flex h-full min-h-0 flex-col bg-canvas" aria-label="Change graph view">
      <div className="flex items-center gap-2.5 border-b border-border bg-surface px-3 py-1.5 text-[0.8125rem]">
        {graph && (
          <span className="text-muted">
            {changed} changed · {graph.nodes.length - changed} using them · {graph.edges.length} links
          </span>
        )}
        {scope && (
          <Button
            variant="ghost"
            className={TOGGLE_ON}
            onClick={() => useGraph.getState().showScope(null)}
            title="Graph every change again"
          >
            <FolderOpen size="0.8125rem" /> {scope}/ <X size="0.75rem" />
          </Button>
        )}
        {full?.cut.length ? (
          <button
            type="button"
            className="cursor-pointer border-0 bg-transparent p-0 text-warn hover:underline"
            onClick={revealCut}
            title="List them in the side panel"
          >
            {full.cut.length} changed symbols not shown
          </button>
        ) : null}
        {full?.inconclusive && (
          <span className="text-warn" title={full.inconclusive}>
            may be incomplete
          </span>
        )}
        <span className="flex-1" />
        <div className="flex items-center gap-1" role="group" aria-label="Show in the graph">
          <FilterChip filter="symbols" title="One box per symbol instead of per file (s)">
            <SquareFunction size="0.8125rem" /> Symbols
          </FilterChip>
          <FilterChip filter="consumers" title="Unchanged code using the change (d)">
            <LayersArrowUp size="0.8125rem" /> Dependents
          </FilterChip>
          <FilterChip filter="tests" title="Tests (T)">
            <FlaskConical size="0.8125rem" /> Tests
          </FilterChip>
        </div>
        <Button
          variant="ghost"
          icon
          disabled={loading}
          onClick={() => void useGraph.getState().reload()}
          title={loading ? 'Loading' : 'Reload'}
          aria-label="Reload"
        >
          {loading ? (
            <LoaderCircle size="0.875rem" className="animate-spin text-accent" />
          ) : (
            <RefreshCw size="0.875rem" />
          )}
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        {loading && !view && (
          <p className="flex items-center gap-2 p-4 text-muted">
            <LoaderCircle size="0.875rem" className="animate-spin text-accent" /> Loading
          </p>
        )}
        {load.state === 'error' && <p className="p-4 text-danger">{load.message}</p>}
        {view && graph!.nodes.length === 0 && (
          <p className="p-4 text-muted">No changed functions, classes or types in this diff.</p>
        )}
        {view && graph!.nodes.length > 0 && <GraphCanvas view={view} clustered={filters.symbols} />}
      </div>
    </section>
  );
}

/** Shows the side panel's list of what the graph left out: it stands where a selection's details do. */
function revealCut() {
  useGraph.getState().deselect();
  useStore.getState().setPanel('graph', { visible: true });
}

/**
 * One on/off filter, as the search bar's toggles are: on is accent-tinted and outlined, off is
 * muted text. Each stands alone, unlike the either/or segmented controls beside it.
 */
function FilterChip({ filter, title, children }: { filter: Filter; title: string; children: ReactNode }) {
  const on = useGraph((s) => s.filters[filter]);
  return (
    <Button
      variant="ghost"
      aria-pressed={on}
      title={title}
      onClick={() => useGraph.getState().setFilter(filter, !on)}
      className={on ? TOGGLE_ON : 'text-muted hover:text-foreground'}
    >
      {children}
    </Button>
  );
}
