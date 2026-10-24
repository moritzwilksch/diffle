import { Dialog, DialogContent } from '@/client/ui/dialog.js';
import { twMerge } from 'tailwind-merge';
import { FileCode2 } from 'lucide-react';
import { memo, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { FilePath } from '@/client/FilePath.js';
import { focusReview } from '@/client/keyboard/useKeymap.js';
import { overflow } from '@/client/review/geometry.js';
import { type Match, useStore } from '@/client/store.js';
import { useGraph } from '@/client/graph/state.js';
import { CodeLine, type HlToken, useHighlighted } from './highlight.js';
import { ReferencePeek } from './ReferencePeek.js';
import { kindColor, KindIcon } from './symbolKind.js';

interface Row {
  i: number;
  line: number;
  text: string;
}

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
    const out: { path: string; under: Match['under']; rows: Row[] }[] = [];
    items.forEach((m, i) => {
      const g = out[out.length - 1];
      if (g && g.path === m.path && g.under?.name === m.under?.name) g.rows.push({ i, line: m.line, text: m.text });
      else out.push({ path: m.path, under: m.under, rows: [{ i, line: m.line, text: m.text }] });
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

  useLayoutEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>('[data-active="true"]');
    if (!list || !row) return;
    // Cover what the header hides once stuck: it sticks below the list's top padding, and its margin keeps
    // the normal gap before the first row. Its current position is no guide when it scrolled away (a wrap).
    const header = row.parentElement?.querySelector('header');
    const pad = getComputedStyle(list);
    const covered = header
      ? (parseFloat(pad.paddingTop) || 0) +
        header.getBoundingClientRect().height +
        (parseFloat(getComputedStyle(header).marginBottom) || 0)
      : 0;
    // The bottom padding belongs to the view too: a row revealed only to the scroller's edge gets clipped.
    const view = list.getBoundingClientRect();
    const bottom = view.bottom - (parseFloat(pad.paddingBottom) || 0);
    list.scrollTop += overflow({ top: view.top, bottom }, row.getBoundingClientRect(), covered);
    // The peek resizes the list, so toggling it can push the active row out of view.
  }, [refs.index, refs.open, refs.peek]);

  if (!refs.open) return null;
  return (
    // Escape is the keymap's: it leaves a peek before it closes the list. A click outside still closes.
    <Dialog open onOpenChange={(_, { reason }) => reason !== 'escape-key' && close()}>
      <DialogContent
        aria-label="References"
        // The review pane is not tabbable, so Base UI would hand focus to a file header's button instead.
        // Over the graph, focus returns to the button that opened the list.
        finalFocus={() => {
          if (useGraph.getState().open) return true;
          focusReview();
          return false;
        }}
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
            ) : refs.kind === 'uses' ? (
              <>
                {items.length} reference{items.length === 1 ? '' : 's'} from{' '}
                <code className="rounded-[0.3125rem] bg-hover px-1.5 py-[1px] font-mono text-foreground">
                  {refs.symbol}
                </code>
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
              <section className="[&+section]:mt-2.5" key={`${g.under?.name}\0${g.path}`}>
                <header className="sticky top-0 z-1 mb-[2px] flex items-center gap-2 rounded-lg border border-border bg-hover px-2.5 py-1.5 font-mono text-[0.75rem] leading-[normal] [&>svg]:flex-none [&>svg]:text-muted">
                  {/* A uses list's lines all sit in the file its title names, so its groups show their entry alone. */}
                  {g.under?.kind === 1 && refs.kind === 'uses' ? (
                    <>
                      <FileCode2 size="0.875rem" />
                      <FilePath path={g.under.name} nowrap className="flex-1" />
                    </>
                  ) : (
                    g.under &&
                    g.under.name !== g.path && (
                      <span className="flex min-w-0 shrink-0 items-center gap-1.5 font-semibold">
                        <KindIcon kind={g.under.kind} size="0.875rem" className="shrink-0" />
                        <span style={{ color: kindColor(g.under.kind) }}>{g.under.name}</span>
                      </span>
                    )
                  )}
                  {refs.kind !== 'uses' && (
                    <>
                      <FileCode2 size="0.875rem" />
                      <FilePath path={g.path} nowrap className="flex-1" />
                    </>
                  )}
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
          {refs.peek && <ReferencePeek items={items} index={refs.index} theme={theme} onPick={pick} />}
        </div>
      </DialogContent>
    </Dialog>
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
