import DiffsWorker from '@pierre/diffs/worker/worker.js?worker';
import { WorkerPoolContextProvider } from '@pierre/diffs/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';
import { applyTheme, readTheme, SHIKI_THEMES } from './theme.js';

// Apply the saved theme before first paint.
applyTheme(readTheme());

performance.mark('diffle:boot');

const poolSize = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WorkerPoolContextProvider
      poolOptions={{ poolSize, workerFactory: () => new DiffsWorker() }}
      // useTokenTransformer: token spans get hit-test data so symbol clicks work; the pool's options win over the viewer's.
      highlighterOptions={{ preferredHighlighter: 'shiki-js', useTokenTransformer: true, theme: SHIKI_THEMES }}
    >
      <App />
    </WorkerPoolContextProvider>
  </StrictMode>,
);
