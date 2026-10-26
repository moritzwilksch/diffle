import { useCallback, useEffect, useState } from 'react';
import { connectWs } from './api.js';
import { Header } from './header/Header.js';
import { HelpOverlay } from './keyboard/HelpOverlay.js';
import { useKeymap } from './keyboard/useKeymap.js';
import { documentTitle } from './model.js';
import { ServerLost } from './ServerLost.js';
import { useStore } from './store.js';
import { FileTreePane } from './tree/FileTreePane.js';
import { TooltipHost } from './ui/TitleTooltips.js';
import './views/registry.js';
import { gridColumns, listViews, panelOf, useViews } from './views/state.js';

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
  const active = useViews((s) => s.active);
  const panel = panelOf(layout, active);
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
      const start = (side === 'tree' ? layout.treeWidth : panel.width) ?? pane?.getBoundingClientRect().width ?? 0;
      const onMove = (ev: PointerEvent) => {
        const delta = side === 'tree' ? ev.clientX - startX : startX - ev.clientX;
        const width = Math.max(180, Math.min(800, start + delta));
        if (side === 'tree') setLayout({ treeWidth: width });
        else useStore.getState().setPanel(active, { width });
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
    [layout.treeWidth, panel.width, active, setLayout],
  );

  const columns = gridColumns(layout, active);

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
      <ViewLayers part="Main" />
      {panel.visible && (
        <>
          <div
            className="cursor-col-resize bg-border opacity-60 [transition:opacity_120ms_ease,_background_120ms_ease] hover:bg-accent hover:opacity-100 data-resizing:bg-accent data-resizing:opacity-100"
            onPointerDown={startResize('panel')}
            title="Drag to resize"
          />
          <ViewLayers part="Side" />
        </>
      )}
      <HelpOverlay />
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

/**
 * One grid cell of every view shown so far. Another view covers the diff instead of replacing it: the
 * diff stays laid out, so switching back keeps its scroll, and a jump scrolls it before it shows.
 */
function ViewLayers({ part }: { part: 'Main' | 'Side' }) {
  const active = useViews((s) => s.active);
  const mounted = useViews((s) => s.mounted);
  return (
    <div className="relative grid min-h-0 min-w-0 grid-cols-1 grid-rows-1">
      {listViews()
        .filter((view) => mounted.includes(view.id))
        .map((view) => {
          const Part = view[part];
          // Laid out but not painted while covered, so the diff cannot show through as a cover repaints.
          if (view.id === 'diff')
            return (
              <div key={view.id} className={active === 'diff' ? 'contents' : 'invisible contents'}>
                <Part />
              </div>
            );
          return (
            <div
              key={view.id}
              className={view.id === active ? 'absolute inset-0 z-10 flex min-h-0 flex-col' : 'hidden'}
            >
              <Part />
            </div>
          );
        })}
    </div>
  );
}
