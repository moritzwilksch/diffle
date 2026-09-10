import { Dialog } from '../ui/Dialog.js';
import { twMerge } from 'tailwind-merge';
import { FileCode2 } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { FilePath } from '../FilePath.js';
import { useStore } from '../store.js';
import { CodeLine, type HlToken, useHighlighted } from './highlight.js';

interface Row {
  i: number;
  line: number;
  text: string;
}

/** Overlay listing a symbol's references grouped by file. j / k or arrows move, Enter or click jumps, Esc closes. */
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
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [refs.index, refs.open]);

  if (!refs.open) return null;
  return (
    <Dialog
      label="References"
      onClose={close}
      className="flex max-h-[80vh] w-[min(60rem,_92vw)] flex-col overflow-hidden p-0"
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
          <kbd>j</kbd> <kbd>k</kbd> move · <kbd>Enter</kbd> jump · <kbd>Esc</kbd> close
        </span>
      </div>
      <div className="overflow-auto px-2.5 pt-2 pb-3" ref={listRef}>
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
