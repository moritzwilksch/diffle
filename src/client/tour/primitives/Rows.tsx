import {
  type DiffLineAnnotation,
  type FileDiffMetadata,
  parsePatchFiles,
  type SupportedLanguages,
} from '@pierre/diffs';
import { FileDiff } from '@pierre/diffs/react';
import { type ReactNode, useCallback, useMemo } from 'react';
import { usePrimed, type WorkerPool } from '@/client/Markdown.js';
import { useStore } from '@/client/store.js';
import { CODE_THEMES, HIGHLIGHTER } from '@/client/theme.js';

/** How the tour draws every excerpt's rows: unified, numbered in the gutter, long lines wrapped. */
const ROWS_OPTIONS = {
  theme: CODE_THEMES,
  preferredHighlighter: HIGHLIGHTER,
  diffStyle: 'unified',
  diffIndicators: 'classic',
  hunkSeparators: 'simple',
  disableFileHeader: true,
  overflow: 'wrap',
} as const;

export interface RowsProps<A> {
  patch: string;
  lang?: string;
  /** Styles for the rows, beside the diff's own. */
  css?: string;
  annotations?: DiffLineAnnotation<A>[];
  renderAnnotation?: (annotation: DiffLineAnnotation<A>) => ReactNode;
  /** Whether the gutter numbers the rows; true unless the numbers would not be the file's. */
  numbered?: boolean;
}

/** A patch's rows, unified, numbered and highlighted like the diff; `lang` overrides its file's. */
export function Rows<A>({ patch, lang, css, annotations, renderAnnotation, numbered = true }: RowsProps<A>) {
  const theme = useStore((s) => s.theme);
  const fileDiff = useMemo(() => rowsDiff(patch, lang), [patch, lang]);
  const options = useMemo(
    () => ({ ...ROWS_OPTIONS, unsafeCSS: css, themeType: theme, disableLineNumbers: !numbered }),
    [theme, css, numbered],
  );
  const prime = useCallback(
    (pool: WorkerPool) => (fileDiff ? pool.primeDiffHighlightCache(fileDiff) : Promise.resolve()),
    [fileDiff],
  );
  const primed = usePrimed(prime);
  if (!fileDiff) return null;
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

/** `patch` as the diff reads it, in `lang` when given; undefined when it holds no file. */
function rowsDiff(patch: string, lang?: string): FileDiffMetadata | undefined {
  const file = parsePatchFiles(patch, `tour:${rowsKey(patch, lang)}`)[0]?.files[0];
  return file && lang ? { ...file, lang: lang as SupportedLanguages } : file;
}

/** A short key naming `patch`'s rows in `lang`: what a highlight is cached under. */
function rowsKey(patch: string, lang = ''): string {
  const text = `${lang}\n${patch}`;
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (h * 33) ^ text.charCodeAt(i);
  return `${(h >>> 0).toString(36)}-${text.length.toString(36)}`;
}
