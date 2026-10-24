import { Check, FileCode2, FlaskConical, LoaderCircle, RefreshCw, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';
import { Button } from '@/client/ui/Button.js';
import { GraphCanvas } from './GraphCanvas.js';
import { type Filter, useGraph } from './state.js';

/** The change graph in the diff's place: what it holds, the view filters, and the canvas. */
export function GraphView() {
  const load = useGraph((s) => s.load);
  const view = useGraph((s) => s.view);
  const filters = useGraph((s) => s.filters);
  const graph = view?.graph;
  const changed = graph?.nodes.filter((n) => n.status !== 'consumer').length ?? 0;
  const full = load.state === 'ready' ? load.graph : null;
  const loading = load.state === 'loading';
  return (
    <section className="flex h-full min-h-0 flex-col bg-canvas" aria-label="Change graph view">
      <div className="flex items-center gap-2.5 border-b border-border px-3 py-1.5 text-[0.8125rem]">
        {graph && (
          <span className="text-muted">
            {changed} changed · {graph.nodes.length - changed} using them · {graph.edges.length} links
          </span>
        )}
        {full?.cutSymbols ? <span className="text-warn">+{full.cutSymbols} changed symbols not drawn</span> : null}
        {full?.inconclusive && (
          <span className="text-warn" title={full.inconclusive}>
            may be incomplete
          </span>
        )}
        <span className="flex-1" />
        <div className="flex items-center gap-1.5" role="group" aria-label="Show in the graph">
          <FilterChip filter="files" title="One box per file instead of per symbol (f)">
            <FileCode2 size="0.8125rem" /> Files
          </FilterChip>
          <FilterChip filter="consumers" title="Unchanged code using the change (u)">
            <Users size="0.8125rem" /> Users
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
        {view && graph!.nodes.length > 0 && <GraphCanvas view={view} clustered={!filters.files} />}
      </div>
    </section>
  );
}

/**
 * One on/off filter. Each stands alone, unlike the either/or segmented controls beside it: a
 * check and an accent tint say it is on.
 */
function FilterChip({ filter, title, children }: { filter: Filter; title: string; children: ReactNode }) {
  const on = useGraph((s) => s.filters[filter]);
  return (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      onClick={() => useGraph.getState().setFilter(filter, !on)}
      className={twMerge(
        'inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[0.8125rem] transition-colors motion-reduce:transition-none [&_svg]:flex-none',
        on
          ? 'border-[color-mix(in_srgb,var(--accent)_45%,transparent)] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-foreground'
          : 'border-border bg-transparent text-muted hover:bg-hover hover:text-foreground',
      )}
    >
      {on ? <Check size="0.75rem" className="text-accent" /> : <span className="w-3" />}
      {children}
    </button>
  );
}
