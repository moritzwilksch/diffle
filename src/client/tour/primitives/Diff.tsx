import { parsePatchFiles } from '@pierre/diffs';
import { FileDiff } from '@pierre/diffs/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FilePath } from '@/client/FilePath.js';
import { usePrimed, type WorkerPool } from '@/client/Markdown.js';
import { useStore } from '@/client/store.js';
import { CODE_THEMES, HIGHLIGHTER } from '@/client/theme.js';
import type { LineRange } from '@/client/tour/document.js';
import { rangePatch } from '@/client/tour/state.js';
import { TourJump } from './Jump.js';

type Shown =
  | { state: 'loading' }
  | { state: 'gone' }
  | { state: 'error'; message: string }
  | { state: 'ready'; patch: string };

/**
 * The lines `range` names, cut from the review's diff when the card renders and highlighted like it.
 * When they left the review, a notice stands in their place and the jump still opens the file.
 */
export function TourDiff({ range }: { range: LineRange }) {
  const { path, side, start, end } = range;
  const version = useStore((s) => s.snapshot?.version);
  const theme = useStore((s) => s.theme);
  const [shown, setShown] = useState<Shown>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    rangePatch({ path, side, start, end }).then(
      (patch) => live && setShown(patch == null ? { state: 'gone' } : { state: 'ready', patch }),
      (e: unknown) => live && setShown({ state: 'error', message: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [path, side, start, end, version]);
  const fileDiff = useMemo(
    () =>
      shown.state === 'ready'
        ? parsePatchFiles(shown.patch, `tour:${version}:${side}:${path}:${start}-${end}`)[0]?.files[0]
        : undefined,
    [shown, version, side, path, start, end],
  );
  const options = useMemo(
    () => ({
      theme: CODE_THEMES,
      preferredHighlighter: HIGHLIGHTER,
      themeType: theme,
      diffStyle: 'unified' as const,
      diffIndicators: 'classic' as const,
      hunkSeparators: 'simple' as const,
      disableFileHeader: true,
      overflow: 'wrap' as const,
    }),
    [theme],
  );
  const prime = useCallback(
    (pool: WorkerPool) => (fileDiff ? pool.primeDiffHighlightCache(fileDiff) : Promise.resolve()),
    [fileDiff],
  );
  const primed = usePrimed(prime);
  const lines = start === end ? `${start}` : `${start}-${end}`;
  return (
    <figure className="tour-block mx-0 overflow-hidden rounded-md border border-border bg-canvas">
      <figcaption className="flex items-center gap-1.5 border-b border-border bg-surface px-2 py-1 text-[0.75rem]">
        <FilePath path={path} className="min-w-0 flex-1" nowrap />
        <span className="shrink-0 font-mono text-muted">
          {side === 'old' ? 'before ' : ''}
          {lines}
        </span>
        <TourJump path={path} line={start} side={side} label="Open" placed />
      </figcaption>
      {shown.state === 'ready' && fileDiff ? (
        <FileDiff key={primed} fileDiff={fileDiff} options={options} />
      ) : (
        <p className={`m-0 px-2.5 py-2 text-[0.75rem] ${shown.state === 'loading' ? 'text-muted' : 'text-warn'}`}>
          {shown.state === 'loading'
            ? 'Loading…'
            : shown.state === 'error'
              ? `Cannot show these lines: ${shown.message}`
              : `Lines ${lines} are no longer in the review; ask the agent for a fresh tour.`}
        </p>
      )}
    </figure>
  );
}
