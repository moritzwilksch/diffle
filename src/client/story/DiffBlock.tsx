import type { FileDiffMetadata } from '@pierre/diffs';
import { FileDiff, useWorkerPool } from '@pierre/diffs/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '@/client/store.js';
import { CODE_THEMES, HIGHLIGHTER } from '@/client/theme.js';

type WorkerPool = NonNullable<ReturnType<typeof useWorkerPool>>;

/** One file's patch, rendered on its own under the story's header for it: no cursor, no comments. */
export function DiffBlock({ fileDiff }: { fileDiff: FileDiffMetadata }) {
  const theme = useStore((s) => s.theme);
  const diffStyle = useStore((s) => s.diffStyle);
  const lineWrap = useStore((s) => s.config.lineWrap);
  const options = useMemo(
    () => ({
      theme: CODE_THEMES,
      preferredHighlighter: HIGHLIGHTER,
      themeType: theme,
      diffStyle,
      diffIndicators: 'classic' as const,
      disableFileHeader: true,
      overflow: lineWrap ? ('wrap' as const) : ('scroll' as const),
    }),
    [theme, diffStyle, lineWrap],
  );
  const prime = useCallback((pool: WorkerPool) => pool.primeDiffHighlightCache(fileDiff), [fileDiff]);
  return <FileDiff key={usePrimed(prime)} fileDiff={fileDiff} options={options} />;
}

/**
 * A key that changes once `prime` has filled the pool's highlight cache: FileDiff paints nothing
 * until a highlight exists, so it remounts on it.
 */
function usePrimed(prime: (pool: WorkerPool) => Promise<void>): string {
  const theme = useStore((s) => s.theme);
  const pool = useWorkerPool();
  const [primed, setPrimed] = useState(0);
  useEffect(() => {
    let live = true;
    if (pool)
      prime(pool)
        .then(() => live && setPrimed((n) => n + 1))
        .catch(() => {});
    return () => {
      live = false;
    };
  }, [pool, prime, theme]);
  return `${theme}:${primed}`;
}
