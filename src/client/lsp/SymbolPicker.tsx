import { Hash, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { FilePath } from '../FilePath.js';
import { useStore } from '../store.js';
import { KIND_LABEL, kindGroup } from './symbolKind.js';

/** Symbol search (gs: current file, gS: repository). Type to filter, ↑/↓ or Ctrl+n/p to move, Enter to jump. */
export function SymbolPicker() {
  const symbols = useStore((s) => s.symbols);
  const querySymbols = useStore((s) => s.querySymbols);
  const moveSymbol = useStore((s) => s.moveSymbol);
  const pickSymbol = useStore((s) => s.pickSymbol);
  const closeSymbols = useStore((s) => s.closeSymbols);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (symbols.open) {
      setQ('');
      ref.current?.focus();
    }
  }, [symbols.open, symbols.scope]);

  useEffect(() => {
    listRef.current?.querySelector('li.on')?.scrollIntoView({ block: 'nearest' });
  }, [symbols.index]);

  if (!symbols.open) return null;

  // Workspace queries are debounced in the store.
  const onChange = (value: string) => {
    setQ(value);
    void querySymbols(value);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const down = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n');
    const up = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p');
    if (down || up) {
      e.preventDefault();
      moveSymbol(down ? 1 : -1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pickSymbol();
    }
  };

  const placeholder =
    symbols.scope === 'document' ? `Symbols in ${symbols.path ?? 'file'}…` : 'Search symbols across the repository…';
  const status = symbols.loading
    ? 'loading…'
    : symbols.items.length
      ? `${symbols.index + 1} / ${symbols.items.length}`
      : '';
  return (
    <div className="symbols" role="dialog" aria-label="Symbols">
      <div className="searchbar">
        <Hash size="0.875rem" />
        <input
          ref={ref}
          value={q}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          spellCheck={false}
        />
        <span className="status">{status}</span>
        <button type="button" className="ghost icon" onClick={closeSymbols} title="Close (Esc)">
          <X size="0.875rem" />
        </button>
      </div>
      {symbols.items.length > 0 ? (
        <ul ref={listRef}>
          {symbols.items.map((sym, i) => (
            <li
              key={`${sym.path}:${sym.line}:${sym.col}:${sym.name}`}
              className={i === symbols.index ? 'on' : ''}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                useStore.setState((s) => ({ symbols: { ...s.symbols, index: i } }));
                pickSymbol();
              }}
            >
              <span className={`kind ${kindGroup(sym.kind)}`}>{KIND_LABEL[sym.kind] ?? 'symbol'}</span>
              <span>
                {sym.name}
                {sym.container && <span className="container"> · {sym.container}</span>}
              </span>
              <span className="where">
                {symbols.scope === 'workspace' && <FilePath path={sym.path} nowrap />}
                {symbols.scope === 'workspace' ? ':' : ''}
                {sym.line}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty">
          {symbols.loading ? '' : symbols.scope === 'workspace' && !q.trim() ? 'Type to search' : 'No symbols'}
        </div>
      )}
    </div>
  );
}
