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
    listRef.current?.querySelector('.ref.on')?.scrollIntoView({ block: 'nearest' });
  }, [refs.index, refs.open]);

  if (!refs.open) return null;
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog references" role="dialog" aria-label="References">
        <div className="references-head">
          <h3>
            {refs.kind === 'types' ? (
              <>
                <code>{refs.symbol}</code> has {items.length} types in its signature; pick one
              </>
            ) : (
              <>
                {items.length} reference{items.length === 1 ? '' : 's'} to <code>{refs.symbol}</code>
              </>
            )}
          </h3>
          <span className="hint">
            <kbd>j</kbd> <kbd>k</kbd> move · <kbd>Enter</kbd> jump · <kbd>Esc</kbd> close
          </span>
        </div>
        <div className="references-list" ref={listRef}>
          {groups.map((g) => (
            <section key={g.path}>
              <header className="ref-file">
                <FileCode2 size="0.875rem" />
                <FilePath path={g.path} nowrap />
                <span className="count">{g.rows.length}</span>
              </header>
              {g.rows.map((r) => (
                <RefRow key={`${r.line}:${r.i}`} row={r} on={r.i === refs.index} tokens={highlighted.get(`${g.path}\n${r.text}`)} onPick={onPick} />
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

/** One reference. Memoized on stable inputs so moving the selection rerenders two rows, not the whole list. */
const RefRow = memo(function RefRow({ row, on, tokens, onPick }: { row: Row; on: boolean; tokens: HlToken[] | undefined; onPick: (i: number) => void }) {
  return (
    <div className={`ref${on ? ' on' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(row.i)}>
      <span className="line">{row.line}</span>
      <span className="code">
        <CodeLine tokens={tokens} fallback={row.text} />
      </span>
    </div>
  );
});
