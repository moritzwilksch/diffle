import { FileCode2, FlaskConical, RefreshCw, Users } from 'lucide-react';
import { Button } from '@/client/ui/Button.js';
import { SegmentedControl, ToggleButton } from '@/client/ui/ToggleButton.js';
import { GraphCanvas } from './GraphCanvas.js';
import { useGraph } from './state.js';

/** The change graph in the diff's place: a toolbar of view filters over the canvas. */
export function GraphView() {
  const load = useGraph((s) => s.load);
  const view = useGraph((s) => s.view);
  const filters = useGraph((s) => s.filters);
  const setFilter = useGraph((s) => s.setFilter);
  const graph = view?.graph;
  const changed = graph?.nodes.filter((n) => n.status !== 'consumer').length ?? 0;
  const full = load.state === 'ready' ? load.graph : null;
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
        <SegmentedControl title="Show in the graph">
          <ToggleButton
            selected={filters.files}
            onClick={() => setFilter('files', !filters.files)}
            title="Files instead of symbols (f)"
          >
            <FileCode2 size="0.875rem" /> Files
          </ToggleButton>
          <ToggleButton
            selected={filters.consumers}
            onClick={() => setFilter('consumers', !filters.consumers)}
            title="Unchanged code using the change (u)"
          >
            <Users size="0.875rem" /> Users
          </ToggleButton>
          <ToggleButton selected={filters.tests} onClick={() => setFilter('tests', !filters.tests)} title="Tests (T)">
            <FlaskConical size="0.875rem" /> Tests
          </ToggleButton>
        </SegmentedControl>
        <Button
          variant="ghost"
          icon
          onClick={() => void useGraph.getState().reload()}
          title="Ask the language servers again"
        >
          <RefreshCw size="0.875rem" />
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        {load.state === 'loading' && !view && <p className="p-4 text-muted">Asking the language servers…</p>}
        {load.state === 'error' && <p className="p-4 text-danger">{load.message}</p>}
        {view && graph!.nodes.length === 0 && (
          <p className="p-4 text-muted">No changed functions, classes or types in this diff.</p>
        )}
        {view && graph!.nodes.length > 0 && <GraphCanvas placed={view.placed} clustered={!filters.files} />}
      </div>
    </section>
  );
}
