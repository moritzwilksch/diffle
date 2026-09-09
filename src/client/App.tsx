import { useCallback, useEffect } from 'react';
import { connectWs } from './api.js';
import { CommentPanel } from './comments/CommentPanel.js';
import { Header } from './header/Header.js';
import { HelpOverlay } from './keyboard/HelpOverlay.js';
import { useKeymap } from './keyboard/useKeymap.js';
import { ReviewPane } from './review/ReviewPane.js';
import { useStore } from './store.js';
import { FileTreePane } from './tree/FileTreePane.js';

export function App() {
  const boot = useStore((s) => s.boot);
  const refreshSnapshot = useStore((s) => s.refreshSnapshot);
  const refreshThreads = useStore((s) => s.refreshThreads);
  const refreshViewed = useStore((s) => s.refreshViewed);
  const refreshConfig = useStore((s) => s.refreshConfig);
  const setLspStatus = useStore((s) => s.setLspStatus);
  const toast = useStore((s) => s.toast);
  const layout = useStore((s) => s.layout);
  const setLayout = useStore((s) => s.setLayout);
  const root = useStore((s) => s.snapshot?.root);
  useKeymap();

  useEffect(() => {
    const name = root?.replace(/\/+$/, '').split('/').pop();
    document.title = name ? `diffle: ${name}` : 'diffle';
  }, [root]);

  const startResize = useCallback(
    (side: 'tree' | 'panel') => (e: React.PointerEvent) => {
      e.preventDefault();
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
        document.body.classList.remove('resizing');
      };
      document.body.classList.add('resizing');
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
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
    const resync = () => void boot().then(() => performance.mark('diffle:snapshot'));
    return connectWs((msg) => {
      switch (msg.type) {
        case 'snapshot':
          void refreshSnapshot(msg.version);
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
    }, resync);
  }, [boot, refreshSnapshot, refreshThreads, refreshViewed, refreshConfig, setLspStatus]);

  return (
    <div className="app" style={{ gridTemplateColumns: columns }}>
      <Header />
      {layout.treeVisible && (
        <>
          <FileTreePane />
          <div className="resizer" onPointerDown={startResize('tree')} title="Drag to resize" />
        </>
      )}
      <ReviewPane />
      {layout.panelVisible && (
        <>
          <div className="resizer" onPointerDown={startResize('panel')} title="Drag to resize" />
          <CommentPanel />
        </>
      )}
      <HelpOverlay />
      {toast && <div className="flash">{toast}</div>}
    </div>
  );
}
