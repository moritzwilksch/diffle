import { useEffect, useMemo, useRef, useState, type Ref } from 'react';
import type { ChangedFile, GraphCluster } from '@/shared/protocol.js';
import { focusReview } from '@/client/keyboard/useKeymap.js';
import { useStore } from '@/client/store.js';
import { Button } from '@/client/ui/Button.js';
import { Dialog, DialogContent } from '@/client/ui/dialog.js';
import { SegmentedControl, ToggleButton } from '@/client/ui/ToggleButton.js';
import { clusterTitle } from '@/client/connected/clusters/clusterTitle.js';
import { GRAPH_TITLE, contextToggleTitle, graphCounts, hideTestsTitle } from '@/client/connected/clusters/copy.js';
import { canListContext } from '@/client/connected/clusters/focus.js';
import { isTestPath } from '@/client/connected/clusters/testPath.js';
import { GraphCanvas, type GraphCanvasHandle, type Selection } from '@/client/connected/canvas/GraphCanvas.js';
import { GraphDetail, announcement, keepSelection } from './GraphDetail.js';
import type { GraphLayout } from '@/client/connected/graph/layout.js';
import { layoutGraph } from '@/client/connected/graph/layout.js';
import { buildGraphModel, graphPending } from '@/client/connected/graph/model.js';

interface Built {
  cluster: GraphCluster;
  context: boolean;
  hiddenTests: number;
  /** The cluster's size once hidden tests are set aside, for the counts line. */
  files: number;
  links: number;
  layout: GraphLayout;
  hiddenFiles: number;
  hiddenLinks: number;
}

function build(cluster: GraphCluster, changed: readonly ChangedFile[], context: boolean, hideTests: boolean): Built {
  const facts = new Map(changed.map((f) => [f.path, f]));
  const model = buildGraphModel(cluster, (path) => facts.get(path), context, hideTests);
  return {
    cluster,
    context,
    hiddenTests: model.hiddenTests,
    files: model.files,
    links: model.links,
    layout: layoutGraph(model),
    hiddenFiles: model.hiddenFiles,
    hiddenLinks: model.hiddenLinks,
  };
}

interface BodyProps {
  built: Built;
  canvas: Ref<GraphCanvasHandle>;
  onOpen(path: string): void;
}

/**
 * Canvas and side panel; the selection lives here, so it starts empty each time the dialog opens. Wide, the
 * panel sits beside the canvas; narrow, under it with its own scroll, so its buttons stay reachable.
 */
function GraphBody({ built, canvas, onOpen }: BodyProps) {
  const [picked, setPicked] = useState<Selection>(null);
  const selected = keepSelection(built.layout, picked);
  // A selection `+ context` took away must not come back when it is toggled on again.
  if (picked !== null && selected === null) setPicked(null);
  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col @4xl:flex-row">
        <div className="min-h-0 min-w-0 flex-1">
          <GraphCanvas
            ref={canvas}
            layout={built.layout}
            selected={selected}
            onSelect={setPicked}
            onOpen={onOpen}
            hiddenFiles={built.hiddenFiles}
            hiddenLinks={built.hiddenLinks}
          />
        </div>
        <div className="flex max-h-2/5 min-h-0 flex-none border-t border-t-border @4xl:max-h-none @4xl:border-t-0">
          <GraphDetail layout={built.layout} selected={selected} onSelect={setPicked} onOpen={onOpen} />
        </div>
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement(built.layout, selected)}
      </p>
    </div>
  );
}

/**
 * The focused cluster's files as a graph. Mounted lazily by the app shell; it stays mounted while it closes,
 * so the exit plays, and its body (canvas, layout) goes with the popup.
 */
export function GraphDialog() {
  const wanted = useStore((s) => s.graphOpen);
  const setWanted = useStore((s) => s.setGraphOpen);
  const graph = useStore((s) => s.graph);
  const version = useStore((s) => s.snapshot?.version);
  const focus = useStore((s) => s.focus);
  const changed = useStore((s) => s.snapshot?.changed);
  const context = useStore((s) => s.context);
  const toggleContext = useStore((s) => s.toggleContext);
  const openFile = useStore((s) => s.openFile);
  const canvas = useRef<GraphCanvasHandle>(null);
  // Off at every open: tests are part of the picture until the reader sets them aside.
  const [hideTests, setHideTests] = useState(false);

  // Mounted already wanted, the popup would have no starting frame to enter from: open it one commit later.
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(wanted);
    if (!wanted) setHideTests(false);
  }, [wanted]);

  // While the graph reloads or lags the snapshot, the dialog keeps what it drew instead of rebuilding.
  const pending = graphPending(graph, version);
  const cluster = useMemo(
    () => (!pending && focus?.kind === 'cluster' ? graph.data?.clusters.find((c) => c.id === focus.id) : undefined),
    [pending, graph.data, focus],
  );
  const tests = cluster ? cluster.files.filter(isTestPath).length : 0;
  const hiding = hideTests && hideTestsTitle(tests, cluster?.files.length ?? 0, true).usable;
  // Built only while wanted: a closed dialog does not lay out again on every refresh or focus step.
  const live = useMemo(
    () => (wanted && cluster && changed ? build(cluster, changed, context, hiding) : null),
    [wanted, cluster, changed, context, hiding],
  );
  // The last build stays for the exit animation, and for a reload.
  const last = useRef(live);
  if (live) last.current = live;
  const built = live ?? last.current;
  useEffect(() => {
    if (wanted && !pending && !live) setWanted(false);
  }, [wanted, pending, live, setWanted]);
  if (!built) return null;

  const jump = (path: string) => {
    setWanted(false);
    void openFile(path);
    requestAnimationFrame(focusReview);
  };
  const canList = canListContext(graph.data, focus);
  const hide = hideTestsTitle(built.cluster.files.filter(isTestPath).length, built.cluster.files.length, hiding);
  return (
    <Dialog open={open} onOpenChange={setWanted}>
      <DialogContent
        aria-label={GRAPH_TITLE}
        data-motion="dialog"
        // The canvas takes focus, not the first button; the review is not tabbable, so it gets focus back by hand.
        initialFocus={() => {
          canvas.current?.focus();
          return false;
        }}
        finalFocus={() => {
          focusReview();
          return false;
        }}
        className="flex h-[min(52rem,_90vh)] w-[min(96rem,_96vw)] max-w-none flex-col overflow-hidden p-0"
      >
        <div className="flex flex-none items-center gap-3 border-b border-b-border px-4.5 pt-3 pb-2.5">
          <div className="min-w-0 flex-1">
            <h3 className="m-0 flex items-baseline gap-2 text-[0.9375rem]">
              {GRAPH_TITLE}
              <span className="truncate font-medium">{clusterTitle(built.cluster)}</span>
              <span className="truncate font-normal text-muted">{built.cluster.label}</span>
            </h3>
            <p className="m-0 text-[0.75rem] text-muted">
              {graphCounts({
                files: built.files,
                links: built.links,
                callers: built.cluster.contextTotal,
                callersDrawn: built.context,
                testsHidden: built.hiddenTests,
              })}
            </p>
          </div>
          <SegmentedControl>
            {/* aria-disabled, not disabled, like the bar's: the reason stays in the title. */}
            <ToggleButton
              type="button"
              selected={context}
              aria-disabled={canList ? undefined : true}
              className={canList ? undefined : 'cursor-default opacity-50 hover:text-muted'}
              title={contextToggleTitle(focus, built.cluster.context.length, built.cluster.contextTotal, false)}
              onClick={() => canList && toggleContext()}
            >
              + context
            </ToggleButton>
          </SegmentedControl>
          <SegmentedControl>
            <ToggleButton
              type="button"
              selected={hiding}
              aria-disabled={hide.usable ? undefined : true}
              className={hide.usable ? undefined : 'cursor-default opacity-50 hover:text-muted'}
              title={hide.title}
              onClick={() => hide.usable && setHideTests((h) => !h)}
            >
              Hide tests
            </ToggleButton>
          </SegmentedControl>
          <Button type="button" onClick={() => setWanted(false)}>
            Close
          </Button>
        </div>
        <GraphBody key={built.cluster.id} built={built} canvas={canvas} onOpen={jump} />
      </DialogContent>
    </Dialog>
  );
}
