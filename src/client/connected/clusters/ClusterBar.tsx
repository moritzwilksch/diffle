import { Waypoints } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { focusReview } from '@/client/keyboard/useKeymap.js';
import { useStore } from '@/client/store.js';
import { Button } from '@/client/ui/Button.js';
import { SegmentedControl, ToggleButton } from '@/client/ui/ToggleButton.js';
import { ClusterRowButton } from './ClusterRowButton.js';
import { contextToggleTitle, elapsedLabel, graphButtonTitle } from './copy.js';
import { canListContext } from './focus.js';
import { canOpenGraph } from './keys.js';
import { clusterRows, type ClusterRow } from './rows.js';
import { useElapsed } from './useElapsed.js';

const PANE_NOTE = 'px-2.5 py-1.5 text-muted';

/** The Connected scope's group list: one row per cluster, then the Unlinked and Other buckets. */
export function ClusterBar() {
  const graph = useStore((s) => s.graph);
  const focus = useStore((s) => s.focus);
  const context = useStore((s) => s.context);
  const loadGraph = useStore((s) => s.loadGraph);
  const toggleContext = useStore((s) => s.toggleContext);
  const setGraphOpen = useStore((s) => s.setGraphOpen);

  const rows = useMemo(() => (graph.data ? clusterRows(graph.data, focus) : []), [graph.data, focus]);
  const focused = rows.find((r) => r.focused);
  const analyzing = !graph.data && graph.status !== 'error';
  const elapsed = elapsedLabel(useElapsed(analyzing));

  // `gt` / `gT` move the focus without the pointer; keep its row in view in a long list.
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    listRef.current?.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest' });
  }, [focused?.focus]);

  if (!graph.data) {
    if (graph.status === 'error') {
      return (
        <div role="alert" className={`${PANE_NOTE} flex items-center gap-2 border-b border-b-border`}>
          <span className="min-w-0 flex-1 text-danger">{graph.error}</span>
          <Button
            onClick={() => {
              void loadGraph();
              requestAnimationFrame(focusReview);
            }}
          >
            Retry
          </Button>
        </div>
      );
    }
    // The timer is hidden from the live region: announcing every second would drown the one message.
    return (
      <div role="status" aria-live="polite" className={`${PANE_NOTE} border-b border-b-border`}>
        Analyzing references…
        {elapsed && (
          <span aria-hidden className="tabular-nums">
            {' '}
            {elapsed}
          </span>
        )}
      </div>
    );
  }
  const { note } = graph.data;
  const noteBlock = note && (
    <div role="note" title={note} className={`${PANE_NOTE} line-clamp-3 border-b border-b-border`}>
      {note}
    </div>
  );
  if (rows.length === 0) {
    return (
      <>
        {noteBlock}
        <div role="status" className={`${PANE_NOTE} border-b border-b-border`}>
          No changed files
        </div>
      </>
    );
  }

  const canList = canListContext(graph.data, focus);
  const canGraph = canOpenGraph(graph.data, focus);
  return (
    <section
      aria-label="Feature clusters"
      aria-busy={graph.status === 'loading'}
      className="flex max-h-[40%] min-h-0 flex-none flex-col border-b border-b-border"
    >
      {noteBlock}
      <ul ref={listRef} className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-0 py-0.5">
        {rows.map((row) => (
          <li key={rowKey(row)}>
            <ClusterRowButton row={row} />
          </li>
        ))}
      </ul>
      {focused?.hint && <p className={`${PANE_NOTE} flex-none border-t border-t-border`}>{focused.hint}</p>}
      <div className="flex flex-none items-center gap-2 border-t border-t-border px-2.5 py-1.5 text-muted">
        <SegmentedControl>
          {/* aria-disabled, not disabled: a disabled button swallows the pointer, and with it the reason in its title. */}
          <ToggleButton
            selected={context}
            aria-disabled={canList ? undefined : true}
            className={canList ? undefined : 'cursor-default opacity-50 hover:text-muted'}
            title={contextToggleTitle(focus, focused?.listed ?? 0, focused?.context ?? 0)}
            onClick={() => {
              if (!canList) return;
              toggleContext();
              requestAnimationFrame(focusReview);
            }}
          >
            + context
          </ToggleButton>
        </SegmentedControl>
        {/* Same aria-disabled pattern: a disabled button would swallow the pointer and with it the reason. */}
        <Button
          type="button"
          aria-disabled={canGraph ? undefined : true}
          className={canGraph ? undefined : 'cursor-default opacity-50 hover:bg-surface'}
          title={graphButtonTitle(focus)}
          onClick={() => canGraph && setGraphOpen(true)}
        >
          <Waypoints size={12} aria-hidden />
          Graph
        </Button>
      </div>
    </section>
  );
}

const rowKey = (row: ClusterRow) => (row.focus.kind === 'cluster' ? row.focus.id : row.focus.kind);
