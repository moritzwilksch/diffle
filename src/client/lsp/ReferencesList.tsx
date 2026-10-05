import { Dialog } from '../ui/Dialog.js';
import { twMerge } from 'tailwind-merge';
import { FileCode2 } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FilePath } from '../FilePath.js';
import { overflow } from '../review/geometry.js';
import { type Match, useStore } from '../store.js';
import type { ThemeChoice } from '../theme.js';
import { CodeLine, type HlToken, highlightLines, useHighlighted } from './highlight.js';

interface Row {
  i: number;
  line: number;
  text: string;
}

/** Lines shown above and below a peeked reference. */
const CONTEXT = 40;

/**
 * Overlay listing a symbol's references grouped by file. j / k or arrows move, Enter or click jumps,
 * Space toggles a peek of the highlighted reference in context, J / K or Ctrl-d / Ctrl-u scroll it, a click on a peeked line
 * jumps there, Esc leaves the peek, then closes.
 */
export function ReferencesList() {
  const refs = useStore((s) => s.references);
  const theme = useStore((s) => s.theme);
  const close = useStore((s) => s.closeReferences);
  const pick = useStore((s) => s.pickReference);
  const listRef = useRef<HTMLDivElement>(null);
  // Trimmed once so highlighting and rendering agree on the text.
  const items = useMemo(() => refs.items.map((m) => ({ ...m, text: m.text.trim() })), [refs.items]);
  const highlighted = useHighlighted(items, theme, refs.index);
  // Built per result set, not per selected index: moving with j/k must not rebuild every row's props.
  const groups = useMemo(() => {
    const out: { path: string; rows: Row[] }[] = [];
    items.forEach((m, i) => {
      const g = out[out.length - 1];
      if (g && g.path === m.path) g.rows.push({ i, line: m.line, text: m.text });
      else out.push({ path: m.path, rows: [{ i, line: m.line, text: m.text }] });
    });
    return out;
  }, [items]);
  const onPick = useCallback(
    (i: number) => {
      useStore.setState((s) => ({ references: { ...s.references, index: i } }));
      pick();
    },
    [pick],
  );

  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>('[data-active="true"]');
    if (!list || !row) return;
    // Use the header's rendered bottom: its sticky position includes the list's top padding, and its
    // margin preserves the normal gap before the first row. Height alone leaves both under the header.
    const header = row.parentElement?.querySelector('header');
    const view = list.getBoundingClientRect();
    const covered = header
      ? header.getBoundingClientRect().bottom + (parseFloat(getComputedStyle(header).marginBottom) || 0) - view.top
      : 0;
    list.scrollTop += overflow(view, row.getBoundingClientRect(), Math.max(0, covered));
  }, [refs.index, refs.open]);

  if (!refs.open) return null;
  const peeked = refs.peek ? items[refs.index] : undefined;
  return (
    <Dialog
      label="References"
      onClose={close}
      className={twMerge(
        'flex max-h-[80vh] w-[min(60rem,_92vw)] flex-col overflow-hidden p-0',
        refs.peek && 'h-[80vh] w-[min(96rem,_96vw)]',
      )}
    >
      <div className="flex items-baseline gap-3.5 border-b border-b-border px-4.5 pt-3.5 pb-2.5">
        <h3 className="m-0 text-[0.9375rem]">
          {refs.kind === 'types' ? (
            <>
              <code className="rounded-[0.3125rem] bg-hover px-1.5 py-[1px] font-mono text-foreground">
                {refs.symbol}
              </code>{' '}
              has {items.length} types in its signature; pick one
            </>
          ) : (
            <>
              {items.length} reference{items.length === 1 ? '' : 's'} to{' '}
              <code className="rounded-[0.3125rem] bg-hover px-1.5 py-[1px] font-mono text-foreground">
                {refs.symbol}
              </code>
            </>
          )}
        </h3>
        <span className="ml-auto text-[0.6875rem] whitespace-nowrap text-muted">
          <kbd>j</kbd> <kbd>k</kbd> move · <kbd>Space</kbd> peek
          {refs.peek && (
            <>
              {' '}
              · <kbd>J</kbd> <kbd>K</kbd> scroll
            </>
          )}{' '}
          · <kbd>Enter</kbd> jump · <kbd>Esc</kbd> {refs.peek ? 'back' : 'close'}
        </span>
      </div>
      <div className={twMerge('flex min-h-0 flex-1', !refs.peek && 'contents')}>
        <div
          className={twMerge(
            'overflow-auto px-2.5 pt-2 pb-3',
            refs.peek && 'w-[min(32rem,_38%)] flex-none border-r border-r-border',
          )}
          ref={listRef}
        >
          {groups.map((g) => (
            <section className="[&+section]:mt-2.5" key={g.path}>
              <header className="sticky top-0 z-1 mb-[2px] flex items-center gap-2 rounded-lg border border-border bg-hover px-2.5 py-1.5 font-mono text-[0.75rem] leading-[normal] [&>svg]:flex-none [&>svg]:text-muted">
                <FileCode2 size="0.875rem" />
                <FilePath path={g.path} nowrap className="flex-1" />
                <span className="ml-auto rounded-[0.625rem] border border-border bg-canvas px-1.75 py-0 text-[0.6875rem] text-muted">
                  {g.rows.length}
                </span>
              </header>
              {g.rows.map((r) => (
                <RefRow
                  key={`${r.line}:${r.i}`}
                  row={r}
                  on={r.i === refs.index}
                  tokens={highlighted.get(`${g.path}\n${r.text}`)}
                  onPick={onPick}
                />
              ))}
            </section>
          ))}
        </div>
        {refs.peek && <ReferencePeek match={peeked} theme={theme} onPick={pick} />}
      </div>
    </Dialog>
  );
}

type Peeked = { path: string; lines: string[] } | { path: string; message: string };

/** The peeked reference's file around its line, highlighted and centered; the list keeps focus. */
function ReferencePeek({
  match,
  theme,
  onPick,
}: {
  match: Match | undefined;
  theme: ThemeChoice;
  onPick: (line: number) => void;
}) {
  const loadFile = useStore((s) => s.loadFile);
  const [file, setFile] = useState<Peeked | null>(null);
  // Keyed by window so a highlight from an earlier reference never paints over the current one.
  const [hl, setHl] = useState<{ key: string; tokens: HlToken[][] } | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const path = match?.path;
  const line = match?.line ?? 0;

  useEffect(() => {
    if (!path) return;
    let live = true;
    loadFile(path, 'new')
      .then(
        (res) =>
          live && setFile(res.binary ? { path, message: 'Binary file' } : { path, lines: res.contents.split('\n') }),
      )
      .catch(
        (e: unknown) =>
          live &&
          setFile({
            path,
            message: e instanceof Error ? e.message : String(e),
          }),
      );
    return () => {
      live = false;
    };
  }, [path, loadFile]);

  const loaded = file && file.path === path && 'lines' in file ? file.lines : null;
  const first = Math.max(1, line - CONTEXT);
  const lines = useMemo(() => loaded?.slice(first - 1, line + CONTEXT) ?? null, [loaded, first, line]);
  const key = `${path}:${first}:${theme}`;

  useEffect(() => {
    if (!lines || !path) return;
    let live = true;
    highlightLines(lines, path, theme)
      .then((tokens) => live && setHl({ key, tokens }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [lines, path, theme, key]);

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
  const tokens = hl?.key === key ? hl.tokens : undefined;
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
                  'grid cursor-pointer grid-cols-[3.25rem_1fr] gap-3 pr-3.5 hover:bg-surface',
                  n === line && 'bg-hover hover:bg-hover',
                )}
                // A drag that selected text is a copy, not a jump.
                onClick={() => getSelection()?.isCollapsed !== false && onPick(n)}
              >
                <span className="text-right text-muted">{n}</span>
                <span className="whitespace-pre">
                  <CodeLine tokens={tokens?.[i]} fallback={text} />
                </span>
              </div>
            );
          })
        ) : file && file.path === path && 'message' in file ? (
          <p className="px-3.5 text-muted">{file.message}</p>
        ) : null}
      </div>
    </div>
  );
}
/** One reference. Memoized on stable inputs so moving the selection rerenders two rows, not the whole list. */
const RefRow = memo(function RefRow({
  row,
  on,
  tokens,
  onPick,
}: {
  row: Row;
  on: boolean;
  tokens: HlToken[] | undefined;
  onPick: (i: number) => void;
}) {
  return (
    <div
      data-active={on}
      className={twMerge(
        `grid cursor-pointer grid-cols-[3.25rem_1fr] gap-3 rounded-md px-2.5 py-0.75 font-mono text-[0.75rem] leading-[1.6] hover:bg-surface ${on ? 'bg-hover hover:bg-hover' : ''}`,
      )}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onPick(row.i)}
    >
      <span className="text-right text-muted">{row.line}</span>
      <span className="overflow-hidden text-ellipsis whitespace-pre">
        <CodeLine tokens={tokens} fallback={row.text} />
      </span>
    </div>
  );
});
