import { twMerge } from 'tailwind-merge';
import { FileCode2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FilePath } from '@/client/FilePath.js';
import { type Match, useStore } from '@/client/store.js';
import type { ThemeChoice } from '@/client/theme.js';
import { CodeLine, type HlToken, highlightLines } from './highlight.js';

/** Lines shown above and below a peeked reference. */
const CONTEXT = 40;

type Peeked = { lines: string[] } | { message: string };

/**
 * The highlighted reference's file around its line, highlighted and centered; the list keeps focus.
 * Files of the references next to it load ahead, so stepping with j / k never paints an empty pane.
 */
export function ReferencePeek({
  items,
  index,
  theme,
  onPick,
}: {
  items: Match[];
  index: number;
  theme: ThemeChoice;
  onPick: (line: number) => void;
}) {
  const loadFile = useStore((s) => s.loadFile);
  const [files, setFiles] = useState<ReadonlyMap<string, Peeked>>(new Map());
  const requested = useRef(new Set<string>());
  // Tokens by `${path}\n${text}`, kept across windows so lines already seen never flash plain again.
  const [hl, setHl] = useState<{ theme: ThemeChoice; tokens: ReadonlyMap<string, HlToken[]> }>({
    theme,
    tokens: new Map(),
  });
  const paneRef = useRef<HTMLDivElement>(null);
  const match = items[index];
  const path = match?.path;
  const line = match?.line ?? 0;

  useEffect(() => {
    for (const m of [items[index], items[index + 1], items[index - 1]]) {
      if (!m || requested.current.has(m.path)) continue;
      const p = m.path;
      requested.current.add(p);
      const settle = (peeked: Peeked) => setFiles((prev) => new Map(prev).set(p, peeked));
      loadFile(p, 'new')
        .then((res) => settle(res.binary ? { message: 'Binary file' } : { lines: res.contents.split('\n') }))
        .catch((e: unknown) => settle({ message: e instanceof Error ? e.message : String(e) }));
    }
  }, [items, index, loadFile]);

  const file = path ? files.get(path) : undefined;
  const loaded = file && 'lines' in file ? file.lines : null;
  const first = Math.max(1, line - CONTEXT);
  const lines = useMemo(() => loaded?.slice(first - 1, line + CONTEXT) ?? null, [loaded, first, line]);
  const tokens = hl.theme === theme ? hl.tokens : undefined;

  useEffect(() => {
    if (!lines || !path) return;
    const known = hl.theme === theme ? hl.tokens : new Map<string, HlToken[]>();
    const missing = [...new Set(lines)].filter((text) => !known.has(`${path}\n${text}`));
    if (missing.length === 0) return;
    let live = true;
    highlightLines(missing, path, theme)
      .then((rows) => {
        if (!live) return;
        setHl((prev) => {
          const next = new Map(prev.theme === theme ? prev.tokens : []);
          rows.forEach((row, i) => next.set(`${path}\n${missing[i]}`, row));
          return { theme, tokens: next };
        });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [lines, path, theme, hl]);

  // Focus lets the browser scroll the peek on the page keys; the keymap still owns j / k and Enter.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    paneRef.current?.focus({ preventScroll: true });
    return () => before?.focus({ preventScroll: true });
  }, []);

  // Center the target before paint so stepping through the list never shows the window scrolled elsewhere.
  useLayoutEffect(() => {
    const pane = paneRef.current;
    const row = pane?.querySelector<HTMLElement>('[data-target="true"]');
    if (!pane || !row) return;
    pane.scrollTop = row.offsetTop - (pane.clientHeight - row.offsetHeight) / 2;
  }, [lines]);

  if (!match) return <div className="flex-1" />;
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-b-border px-3.5 py-1.5 font-mono text-[0.75rem] text-muted [&>svg]:flex-none">
        <FileCode2 size="0.875rem" />
        <FilePath path={match.path} nowrap className="min-w-0 flex-1" />
        <span className="ml-auto">:{match.line}</span>
      </div>
      <div
        className="relative flex-1 overflow-auto py-2 font-mono text-[0.75rem] leading-[1.6] outline-none"
        role="region"
        aria-label="Peek"
        tabIndex={-1}
        ref={paneRef}
      >
        {lines ? (
          lines.map((text, i) => {
            const n = first + i;
            return (
              <div
                key={n}
                data-target={n === line}
                className={twMerge(
                  'group grid cursor-pointer grid-cols-[3.25rem_1fr] gap-3 pr-3.5',
                  n === line && 'bg-hover',
                )}
                // A drag that selected text is a copy, not a jump.
                onClick={() => getSelection()?.isCollapsed !== false && onPick(n)}
              >
                {/* Hover tints the line number alone, as the diff view does. */}
                <span className="pr-1.5 text-right text-muted group-hover:bg-hover group-hover:text-foreground">
                  {n}
                </span>
                <span className="whitespace-pre">
                  <CodeLine tokens={tokens?.get(`${match.path}\n${text}`)} fallback={text} />
                </span>
              </div>
            );
          })
        ) : file && 'message' in file ? (
          <p className="px-3.5 text-muted">{file.message}</p>
        ) : null}
      </div>
    </div>
  );
}
