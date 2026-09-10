import { twMerge } from 'tailwind-merge';
import { Button } from '../ui/Button.js';
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
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
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
  const kindColor: Record<string, string> = {
    type: 'text-kind-type',
    callable: 'text-kind-callable',
    value: 'text-kind-value',
    scope: 'text-muted',
    other: 'text-muted',
  };
  const status = symbols.loading
    ? 'loading…'
    : symbols.items.length
      ? `${symbols.index + 1} / ${symbols.items.length}`
      : '';
  return (
    <div
      className="absolute top-0 right-0 left-0 z-30 flex max-h-[60%] flex-col border-b border-b-border bg-surface shadow-[0_0.625rem_1.875rem_rgba(0,_0,_0,_0.18)]"
      role="dialog"
      aria-label="Symbols"
    >
      <div className="flex items-center gap-2 border-b border-b-border bg-surface px-2.5 py-1.5">
        <Hash size="0.875rem" />
        <input
          className="flex-1 rounded-md border border-border bg-canvas px-2 py-1 font-mono text-[0.75rem]"
          ref={ref}
          value={q}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          spellCheck={false}
        />
        <span className="min-w-17.5 text-right font-mono text-[0.75rem] leading-[normal] text-muted">{status}</span>
        <Button type="button" variant="ghost" icon onClick={closeSymbols} title="Close (Esc)">
          <X size="0.875rem" />
        </Button>
      </div>
      {symbols.items.length > 0 ? (
        <ul role="listbox" aria-label="Symbols" className="m-0 list-none overflow-auto p-1" ref={listRef}>
          {symbols.items.map((sym, i) => (
            <li
              role="option"
              aria-selected={i === symbols.index}
              key={`${sym.path}:${sym.line}:${sym.col}:${sym.name}`}
              className={twMerge(
                'grid cursor-pointer grid-cols-[4rem_1fr_auto] items-baseline gap-2.5 rounded-md px-2 py-1 font-mono text-[0.75rem] leading-[normal]',
                i === symbols.index ? 'bg-hover' : '',
              )}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                useStore.setState((s) => ({ symbols: { ...s.symbols, index: i } }));
                pickSymbol();
              }}
            >
              <span className={twMerge(`text-[0.6875rem] text-muted lowercase ${kindColor[kindGroup(sym.kind)]}`)}>
                {KIND_LABEL[sym.kind] ?? 'symbol'}
              </span>
              <span>
                {sym.name}
                {sym.container && <span className="text-muted"> · {sym.container}</span>}
              </span>
              <span className="text-[0.6875rem] whitespace-nowrap text-muted">
                {symbols.scope === 'workspace' && <FilePath path={sym.path} nowrap />}
                {symbols.scope === 'workspace' ? ':' : ''}
                {sym.line}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="p-3">
          {symbols.loading ? '' : symbols.scope === 'workspace' && !q.trim() ? 'Type to search' : 'No symbols'}
        </div>
      )}
    </div>
  );
}
