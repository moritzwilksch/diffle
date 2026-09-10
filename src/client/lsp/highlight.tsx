import { getFiletypeFromFileName, getSharedHighlighter, type SupportedLanguages } from '@pierre/diffs';
import { useEffect, useMemo, useRef, useState } from 'react';
import { SHIKI_THEMES, type ThemeChoice } from '../theme.js';

export interface HlToken {
  text: string;
  color?: string;
}

/** Lines tokenized between yields to the event loop; a big result file must not hold the main thread. */
const CHUNK = 200;

function isDark(choice: ThemeChoice): boolean {
  if (choice !== 'system') return choice === 'dark';
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Tokenize single lines with the viewer's shared highlighter and theme, for lists
 * rendered outside the diff viewer. One line at a time keeps state simple.
 */
export async function highlightLines(lines: string[], path: string, theme: ThemeChoice): Promise<HlToken[][]> {
  return highlightCode(lines, getFiletypeFromFileName(path) as SupportedLanguages, theme);
}

/** Like `highlightLines`, for a language named directly (a markdown fence's info string). */
export async function highlightCode(
  lines: string[],
  lang: SupportedLanguages,
  theme: ThemeChoice,
): Promise<HlToken[][]> {
  const themeName = isDark(theme) ? SHIKI_THEMES.dark : SHIKI_THEMES.light;
  const highlighter = await getSharedHighlighter({ themes: [SHIKI_THEMES.dark, SHIKI_THEMES.light], langs: [lang] });
  return lines.map((line) => {
    try {
      const [tokens = []] = highlighter.codeToTokensBase(line, { lang, theme: themeName });
      return tokens.map((t) => ({ text: t.content, color: t.color }));
    } catch {
      return [{ text: line }];
    }
  });
}

const yieldToLoop = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Highlighted tokens per item, keyed by `${path}\n${text}`; plain text until the
 * highlighter answers. Files are tokenized one at a time, nearest to `near` (an
 * index into `items`, read live so moving the selection redirects the queue
 * without restarting it) first, and the map grows as each file finishes. Rows
 * go plain when `items` change but keep their old colors across a theme toggle.
 * Token arrays keep their identity across updates so memoized rows stay put.
 */
export function useHighlighted(
  items: { path: string; text: string }[],
  theme: ThemeChoice,
  near = 0,
): Map<string, HlToken[]> {
  // The map is tagged with the item array it describes, so a render can never
  // show highlights computed for a different result set.
  const [state, setState] = useState<{ items: typeof items; map: Map<string, HlToken[]> }>(() => ({
    items,
    map: new Map(),
  }));
  const nearRef = useRef(near);
  nearRef.current = near;
  useEffect(() => {
    let cancelled = false;
    // A new result set starts plain; a theme toggle keeps the old colors until each file is redone.
    setState((prev) => (prev.items === items ? prev : { items, map: new Map() }));
    const files: { path: string; lines: string[]; first: number; last: number }[] = [];
    items.forEach((it, i) => {
      const f = files[files.length - 1];
      if (f && f.path === it.path) {
        f.lines.push(it.text);
        f.last = i;
      } else files.push({ path: it.path, lines: [it.text], first: i, last: i });
    });
    const distance = (f: (typeof files)[number]) => {
      const n = nearRef.current;
      return n < f.first ? f.first - n : n > f.last ? n - f.last : 0;
    };
    void (async () => {
      const pending = [...files];
      while (pending.length > 0 && !cancelled) {
        let best = 0;
        for (let i = 1; i < pending.length; i++) if (distance(pending[i]!) < distance(pending[best]!)) best = i;
        const [file] = pending.splice(best, 1);
        const { path, lines } = file!;
        const rows: HlToken[][] = [];
        for (let at = 0; at < lines.length && !cancelled; at += CHUNK) {
          const chunk = lines.slice(at, at + CHUNK);
          rows.push(...(await highlightLines(chunk, path, theme).catch(() => chunk.map((l) => [{ text: l }]))));
          // Let the list paint and input land between chunks and files.
          await yieldToLoop();
        }
        if (cancelled) return;
        setState((prev) => {
          // A result set that changed while this file was tokenizing must not resurface.
          if (prev.items !== items) return prev;
          const next = new Map(prev.map);
          rows.forEach((tokens, i) => next.set(`${path}\n${lines[i]}`, tokens));
          return { items: prev.items, map: next };
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [items, theme]);
  // Passive effects may run after paint; never expose stale highlights for a changed result set.
  return state.items === items ? state.map : new Map();
}

/**
 * A code block highlighted as `lang`, plain until the highlighter answers and
 * plain for good when it does not know the language.
 */
export function HighlightedCode({ code, lang, theme }: { code: string; lang: string; theme: ThemeChoice }) {
  const [rows, setRows] = useState<HlToken[][] | null>(null);
  const lines = useMemo(() => code.replace(/\n$/, '').split('\n'), [code]);
  useEffect(() => {
    let live = true;
    setRows(null);
    highlightCode(lines, lang as SupportedLanguages, theme)
      .then((r) => live && setRows(r))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [lines, lang, theme]);
  return (
    <>
      {lines.map((line, i) => (
        <span key={i}>
          <CodeLine tokens={rows?.[i]} fallback={line} />
          {'\n'}
        </span>
      ))}
    </>
  );
}

export function CodeLine({ tokens, fallback }: { tokens?: HlToken[]; fallback: string }) {
  if (!tokens) return <>{fallback}</>;
  return (
    <>
      {tokens.map((t, i) => (
        <span key={i} style={t.color ? { color: t.color } : undefined}>
          {t.text}
        </span>
      ))}
    </>
  );
}
