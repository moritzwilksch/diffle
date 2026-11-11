import { type AnnotationSide, type DiffLineAnnotation, type FileDiffMetadata, parsePatchFiles } from '@pierre/diffs';
import { FileDiff } from '@pierre/diffs/react';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { FilePath } from '@/client/FilePath.js';
import { usePrimed, type WorkerPool } from '@/client/Markdown.js';
import { useStore } from '@/client/store.js';
import { CODE_THEMES, HIGHLIGHTER } from '@/client/theme.js';
import type { LineRange } from '@/client/tour/document.js';
import { rangePatch } from '@/client/tour/state.js';
import { TourJump } from './Jump.js';
import type { Place } from '@/client/tour/anchor.js';

/** What an excerpt shows: its rows once cut, or why it shows none. */
export type Shown =
  | { state: 'loading' }
  | { state: 'gone' }
  | { state: 'error'; message: string }
  | { state: 'ready'; patch: string; fileDiff: FileDiffMetadata };

/** The lines `range` names, cut from the review's diff, again whenever the snapshot moves. */
export function useExcerpt(range: LineRange): Shown {
  const { path, side, start, end } = range;
  const version = useStore((s) => s.snapshot?.version);
  const [shown, setShown] = useState<Shown>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    rangePatch({ path, side, start, end }).then(
      (patch) => {
        if (!live) return;
        const fileDiff =
          patch == null
            ? undefined
            : parsePatchFiles(patch, `tour:${version}:${side}:${path}:${start}-${end}`)[0]?.files[0];
        setShown(patch == null || !fileDiff ? { state: 'gone' } : { state: 'ready', patch, fileDiff });
      },
      (e: unknown) => live && setShown({ state: 'error', message: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [path, side, start, end, version]);
  return shown;
}

/** `start-end`, or one line alone, as a range's header shows it. */
export function linesLabel({ start, end }: LineRange): string {
  return start === end ? `${start}` : `${start}-${end}`;
}

/** What stands in for an excerpt's rows while they load, or once they are gone. */
export function ExcerptNotice({ shown, range }: { shown: Exclude<Shown, { state: 'ready' }>; range: LineRange }) {
  return (
    <p
      data-opaque=""
      className={`m-0 px-2.5 py-2 text-[0.75rem] ${shown.state === 'loading' ? 'text-muted' : 'text-warn'}`}
    >
      {shown.state === 'loading'
        ? 'Loading…'
        : shown.state === 'error'
          ? `Cannot show these lines: ${shown.message}`
          : `Lines ${linesLabel(range)} are no longer in the review; ask the agent for a fresh tour.`}
    </p>
  );
}

/**
 * The lines `range` names, cut from the review's diff when the card renders and highlighted like it.
 * When they left the review, a notice stands in their place and the jump still opens the file.
 */
export function TourDiff({ range, place }: { range: LineRange; place?: Place }) {
  const shown = useExcerpt(range);
  return (
    <figure
      {...place}
      data-opaque=""
      className="tour-block mx-0 overflow-hidden rounded-md border border-border bg-canvas"
    >
      <figcaption className="flex items-center gap-1.5 border-b border-border bg-surface px-2 py-1 text-[0.75rem]">
        <FilePath path={range.path} className="min-w-0 flex-1" nowrap />
        <span className="shrink-0 font-mono text-muted">
          {range.side === 'old' ? 'before ' : ''}
          {linesLabel(range)}
        </span>
        <TourJump path={range.path} line={range.start} side={range.side} label="Open" placed />
      </figcaption>
      {shown.state === 'ready' ? <DiffRows fileDiff={shown.fileDiff} /> : <ExcerptNotice shown={shown} range={range} />}
    </figure>
  );
}

/**
 * A patch's rows as the tour shows every excerpt: unified, numbered in the gutter, long lines
 * wrapped, highlighted like the diff view. A code block uses it too, so the two read alike.
 */
export function DiffRows<A = undefined>({
  fileDiff,
  css,
  annotations,
  renderAnnotation,
  onLineNumberClick,
}: {
  fileDiff: FileDiffMetadata;
  /** Styles for the rows, inside the diff's shadow root. */
  css?: string;
  annotations?: DiffLineAnnotation<A>[];
  renderAnnotation?: (annotation: DiffLineAnnotation<A>) => ReactNode;
  onLineNumberClick?: (spot: { side: AnnotationSide; lineNumber: number }) => void;
}) {
  const theme = useStore((s) => s.theme);
  const options = useMemo(
    () => ({
      unsafeCSS: css,
      onLineNumberClick:
        onLineNumberClick &&
        ((p: { annotationSide: AnnotationSide; lineNumber: number }) =>
          onLineNumberClick({ side: p.annotationSide, lineNumber: p.lineNumber })),
      theme: CODE_THEMES,
      preferredHighlighter: HIGHLIGHTER,
      themeType: theme,
      diffStyle: 'unified' as const,
      diffIndicators: 'classic' as const,
      hunkSeparators: 'simple' as const,
      disableFileHeader: true,
      overflow: 'wrap' as const,
    }),
    [theme, css, onLineNumberClick],
  );
  const prime = useCallback((pool: WorkerPool) => pool.primeDiffHighlightCache(fileDiff), [fileDiff]);
  const primed = usePrimed(prime);
  return (
    <FileDiff
      key={primed}
      fileDiff={fileDiff}
      options={options}
      lineAnnotations={annotations}
      renderAnnotation={renderAnnotation}
    />
  );
}
