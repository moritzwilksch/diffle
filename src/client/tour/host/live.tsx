import { type FileDiffMetadata, parsePatchFiles, type SupportedLanguages } from '@pierre/diffs';
import { FileDiff } from '@pierre/diffs/react';
import type { LucideIcon } from 'lucide-react';
import { createElement, useCallback, useEffect, useMemo, useState } from 'react';
import { highlightCode } from '@/client/lsp/highlight.js';
import { usePrimed, type WorkerPool } from '@/client/Markdown.js';
import { useStore } from '@/client/store.js';
import { CODE_THEMES, HIGHLIGHTER } from '@/client/theme.js';
import type { Place } from '@/client/tour/anchor.js';
import type { LineRange } from '@/client/tour/document.js';
import { jump, rangePatch } from '@/client/tour/state.js';
import { type DrawIcon, type RowsProps, rowsKey, type Shown, type Token, type TourHost } from './host.js';
import { LiveCheck } from './LiveCheck.js';
import { LiveSymbol } from './LiveSymbol.js';

/** How the tour draws every excerpt's rows: unified, numbered in the gutter, long lines wrapped. */
export const ROWS_OPTIONS = {
  theme: CODE_THEMES,
  preferredHighlighter: HIGHLIGHTER,
  diffStyle: 'unified',
  diffIndicators: 'classic',
  hunkSeparators: 'simple',
  disableFileHeader: true,
  overflow: 'wrap',
} as const;

/** `patch` as the diff reads it, in `lang` when given; undefined when it holds no file. */
export function rowsDiff(patch: string, lang?: string): FileDiffMetadata | undefined {
  const file = parsePatchFiles(patch, `tour:${rowsKey(patch, lang)}`)[0]?.files[0];
  return file && lang ? { ...file, lang: lang as SupportedLanguages } : file;
}

/** The tour in the review: its excerpts cut from the review's diff, its symbols asked of the language servers. */
export const liveHost: TourHost = {
  useExcerpt,
  Rows,
  open: (path, line, side) => void jump(path, line, side),
  Symbol: LiveSymbol,
  Check: LiveCheck,
  useChanged,
  useTokens,
  useIcon,
  useFocusedChild,
};

function useExcerpt(range: LineRange, context: number): Shown {
  const { path, side, start, end } = range;
  const version = useStore((s) => s.snapshot?.version);
  const [shown, setShown] = useState<Shown>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    rangePatch({ path, side, start, end }, context).then(
      (patch) => live && setShown(patch == null ? { state: 'gone' } : { state: 'ready', patch }),
      (e: unknown) => live && setShown({ state: 'error', message: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [path, side, start, end, context, version]);
  return shown;
}

function Rows<A>({ patch, lang, css, annotations, renderAnnotation, numbered = true }: RowsProps<A>) {
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

function useChanged() {
  const changed = useStore((s) => s.snapshot?.changed);
  return useMemo(() => new Map(changed?.map((f) => [f.path, f])), [changed]);
}

function useTokens(lines: readonly string[], lang: string): Token[][] | null {
  const theme = useStore((s) => s.theme);
  const [tokens, setTokens] = useState<Token[][] | null>(null);
  const source = lines.join('\n');
  useEffect(() => {
    let live = true;
    highlightCode(source.split('\n'), lang as SupportedLanguages, theme)
      .then((r) => live && setTokens(r))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [source, lang, theme]);
  return tokens;
}

/** Each name looked up so far, null when no icon has it, so a later mount draws it at once. */
const loaded = new Map<string, LucideIcon | null>();

/** The icon `name`, from the one chunk holding every icon; null when no icon has the name. */
export async function loadIcon(name: string): Promise<LucideIcon | null> {
  const known = loaded.get(name);
  if (known !== undefined) return known;
  const { iconNamed } = await import('./icons.js');
  const icon = iconNamed(name);
  loaded.set(name, icon);
  return icon;
}

/** An icon loaded on first use, so the main bundle carries none. */
function useIcon(name: string): DrawIcon | null | undefined {
  const [icon, setIcon] = useState(() => loaded.get(name));
  useEffect(() => {
    let current = true;
    void loadIcon(name).then((icon) => current && setIcon(icon));
    return () => {
      current = false;
    };
  }, [name]);
  return icon && ((props) => createElement(icon, props));
}

function useFocusedChild(place: Place, onFocus: (child: number) => void): void {
  const block = place['data-node'];
  const child = useStore((s) => {
    const thread = s.focusedThread == null ? undefined : s.threads.find((t) => t.id === s.focusedThread);
    if (thread?.anchor.kind !== 'tour') return null;
    const node = thread.anchor.node.join('.');
    return node.startsWith(`${block}.`) ? Number(node.slice(block.length + 1).split('.')[0]) : null;
  });
  useEffect(() => {
    if (child != null) onFocus(child);
  }, [child, onFocus]);
}
