import diffsWorker from '@pierre/diffs/worker/worker.js?chunk-url';
import { WorkerPoolContextProvider } from '@pierre/diffs/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';
import { applyTextSize } from './scale.js';
import { flushReviewLocation, rememberReviewLocation } from './review/location.js';
import { useStore } from './store.js';
import { applyTheme, CODE_THEMES, HIGHLIGHTER, readTheme } from './theme.js';

applyTheme(readTheme());
useStore.subscribe((s, prev) => {
  if (s.config.textScale !== prev.config.textScale) applyTextSize(s.config.textScale);
  rememberReviewLocation(s, prev);
});
window.addEventListener('pagehide', flushReviewLocation);

performance.mark('diffle:boot');

const poolSize = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WorkerPoolContextProvider
      poolOptions={{ poolSize, workerFactory: () => new Worker(diffsWorker, { type: 'module' }) }}
      // useTokenTransformer: token spans get hit-test data so symbol clicks work; the pool's options win over the viewer's.
      highlighterOptions={{ preferredHighlighter: HIGHLIGHTER, useTokenTransformer: true, theme: CODE_THEMES }}
    >
      <App />
    </WorkerPoolContextProvider>
  </StrictMode>,
);
