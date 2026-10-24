import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { connectWs } from './api.js';
import { CommentPanel } from './comments/CommentPanel.js';
import { Header } from './header/Header.js';
import { HelpOverlay } from './keyboard/HelpOverlay.js';
import { useKeymap } from './keyboard/useKeymap.js';
import { documentTitle } from './model.js';
import { ReviewPane } from './review/ReviewPane.js';
import { ServerLost } from './ServerLost.js';
import { useStore } from './store.js';
import { FileTreePane } from './tree/FileTreePane.js';
import { TooltipHost } from './ui/TitleTooltips.js';

// The graph (dagre, the canvas, the dialog) is a chunk of its own, fetched when the dialog first opens.
const loadGraphDialog = () =>
  lazy(() => import('./connected/dialog/GraphDialog.js').then((m) => ({ default: m.GraphDialog })));

/** Catches a failed chunk load (or a crash in the dialog), so it cannot unmount the whole app. */
class GraphBoundary extends Component<{ onError(error: unknown): void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function GraphDialogHost() {
  const open = useStore((s) => s.graphOpen);
  // A rejected import stays rejected inside its lazy component: after a failure the next open builds a new one.
  const [Dialog, setDialog] = useState(loadGraphDialog);
  const [attempt, setAttempt] = useState(0);
  const seen = useRef(false);
  if (open) seen.current = true;
  if (!seen.current) return null;
  return (
    <GraphBoundary
      key={attempt}
      onError={(e) => {
        seen.current = false;
        useStore.getState().report('Loading the graph', e);
        useStore.getState().setGraphOpen(false);
        setDialog(loadGraphDialog);
        setAttempt((n) => n + 1);
      }}
    >
      <Suspense fallback={null}>
        <Dialog />
      </Suspense>
    </GraphBoundary>
  );
}

export function App() {
  const boot = useStore((s) => s.boot);
  const refreshSnapshot = useStore((s) => s.refreshSnapshot);
  const refreshThreads = useStore((s) => s.refreshThreads);
  const refreshViewed = useStore((s) => s.refreshViewed);
  const refreshConfig = useStore((s) => s.refreshConfig);
  const setLspStatus = useStore((s) => s.setLspStatus);
  const setMoved = useStore((s) => s.setMoved);
  const toast = useStore((s) => s.toast);
  const layout = useStore((s) => s.layout);
  const setLayout = useStore((s) => s.setLayout);
  const title = useStore((s) => (s.snapshot ? documentTitle(s.snapshot, s.github.data) : 'diffle'));
  const [lost, setLost] = useState(false);
  useKeymap();

  useEffect(() => {
    document.title = title;
  }, [title]);

  const startResize = useCallback(
    (side: 'tree' | 'panel') => (e: React.PointerEvent) => {
      e.preventDefault();
      const resizer = e.currentTarget;
      const startX = e.clientX;
      // Until the first drag the width is the stylesheet's; measure it so the pane does not jump.
      const pane = side === 'tree' ? e.currentTarget.previousElementSibling : e.currentTarget.nextElementSibling;
      const start =
        (side === 'tree' ? layout.treeWidth : layout.panelWidth) ?? pane?.getBoundingClientRect().width ?? 0;
      const onMove = (ev: PointerEvent) => {
        const delta = side === 'tree' ? ev.clientX - startX : startX - ev.clientX;
        const width = Math.max(180, Math.min(800, start + delta));
        setLayout(side === 'tree' ? { treeWidth: width } : { panelWidth: width });
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
        delete document.body.dataset.resizing;
        resizer.removeAttribute('data-resizing');
      };
      document.body.dataset.resizing = '';
      resizer.setAttribute('data-resizing', '');
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
    },
    [layout.treeWidth, layout.panelWidth, setLayout],
  );

  const columns = [
    layout.treeVisible ? `${layout.treeWidth == null ? '17.5rem' : `${layout.treeWidth}px`} 4px` : '',
    'minmax(0, 1fr)',
    layout.panelVisible ? `4px ${layout.panelWidth == null ? '21.25rem' : `${layout.panelWidth}px`}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  useEffect(() => {
    // Every (re)connection resyncs the whole state: pushes missed while the socket was down are
    // not replayed, and the first open is the boot itself.
    const resync = () => {
      setLost(false);
      void boot().then(() => performance.mark('diffle:snapshot'));
    };
    return connectWs(
      (msg) => {
        switch (msg.type) {
          case 'snapshot':
            void refreshSnapshot(msg.version);
            break;
          case 'moved':
            setMoved(msg.moved);
            break;
          case 'threads':
            void refreshThreads();
            break;
          case 'viewed':
            void refreshViewed();
            break;
          case 'config':
            void refreshConfig();
            break;
          case 'lsp':
            setLspStatus(msg.payload);
            break;
          default:
            break;
        }
      },
      resync,
      () => setLost(true),
    );
  }, [boot, refreshSnapshot, refreshThreads, refreshViewed, refreshConfig, setLspStatus, setMoved]);

  return (
    <div className="grid h-full grid-rows-[2.5rem_1fr]" style={{ gridTemplateColumns: columns }}>
      <Header />
      {layout.treeVisible && (
        <>
          <FileTreePane />
          <div
            className="cursor-col-resize bg-border opacity-60 [transition:opacity_120ms_ease,_background_120ms_ease] hover:bg-accent hover:opacity-100 data-resizing:bg-accent data-resizing:opacity-100"
            onPointerDown={startResize('tree')}
            title="Drag to resize"
          />
        </>
      )}
      <ReviewPane />
      {layout.panelVisible && (
        <>
          <div
            className="cursor-col-resize bg-border opacity-60 [transition:opacity_120ms_ease,_background_120ms_ease] hover:bg-accent hover:opacity-100 data-resizing:bg-accent data-resizing:opacity-100"
            onPointerDown={startResize('panel')}
            title="Drag to resize"
          />
          <CommentPanel />
        </>
      )}
      <HelpOverlay />
      <GraphDialogHost />
      <TooltipHost />
      {lost && <ServerLost />}
      {toast && (
        <div className="fixed bottom-6 left-[50%] z-60 max-w-[min(48rem,_90vw)] [transform:translateX(-50%)] [animation:flash-in_160ms_ease] rounded-lg bg-foreground px-5 py-3 text-[1rem] leading-[1.4] wrap-anywhere text-canvas shadow-[0_0.5rem_1.5rem_rgba(0,_0,_0,_0.35)]">
          {toast}
        </div>
      )}
    </div>
  );
}
