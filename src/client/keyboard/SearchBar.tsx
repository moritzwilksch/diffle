import { twMerge } from 'tailwind-merge';
import { Button } from '../ui/Button.js';
import { FileDiff, FileSearch, Link2, Search, WholeWord, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useStore } from '../store.js';

/** Content search (/ in the current file, g/ across changed files), the references of a symbol (gA), or a word's occurrences (* / #). Enter runs a search; n / N step through matches. */
export function SearchBar({ path }: { path?: string }) {
  const visible = useStore((s) => {
    const local = s.search.kind === 'text' && s.search.scope === 'file';
    return s.search.open && (local ? s.search.path === path : path === undefined);
  });
  return visible ? <SearchForm /> : null;
}

function SearchForm() {
  const search = useStore((s) => s.search);
  const runSearch = useStore((s) => s.runSearch);
  const closeSearch = useStore((s) => s.closeSearch);
  const setSearchOptions = useStore((s) => s.setSearchOptions);
  const setSearchInput = useStore((s) => s.setSearchInput);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Virtualization can remount this input during a wheel gesture; focus must not move the viewport.
    if (search.editing) ref.current?.focus({ preventScroll: true });
  }, [search.editing, search.focusNonce]);

  const n = search.matches.length;
  if (search.kind !== 'text') {
    return (
      <div className="flex items-center gap-2 border-b border-b-border bg-surface px-2.5 py-1.5">
        {search.kind === 'references' ? <Link2 size="0.875rem" /> : <WholeWord size="0.875rem" />}
        <span className="flex-1 font-mono text-[0.75rem] leading-[normal] text-muted [&_code]:text-foreground">
          {search.kind === 'references'
            ? 'references to'
            : search.direction === 1
              ? 'occurrences of'
              : 'occurrences (upwards) of'}{' '}
          <code>{search.query}</code>
        </span>
        <span className="min-w-17.5 text-right font-mono text-[0.75rem] leading-[normal] text-muted">
          {search.loading ? 'searching…' : n ? `${search.index + 1} / ${n}${search.truncated ? '+' : ''}` : 'none'}
        </span>
        <Button type="button" variant="ghost" icon onClick={closeSearch} title="Close (Esc)">
          <X size="0.875rem" />
        </Button>
      </div>
    );
  }
  const fullFile = search.content[search.scope] === 'full';
  const ScopeIcon = fullFile ? FileSearch : FileDiff;
  return (
    <form
      className="flex items-center gap-2 border-b border-b-border bg-surface px-2.5 py-1.5"
      onClick={(e) => e.stopPropagation()}
      onSubmit={(e) => {
        e.preventDefault();
        void runSearch(search.input).then(() => {
          ref.current?.blur();
          document.querySelector<HTMLElement>('main[tabindex]')?.focus({ preventScroll: true });
        });
      }}
    >
      <Search size="0.875rem" />
      <input
        data-content-search=""
        className="min-w-0 flex-1 rounded-md border border-border bg-canvas px-2 py-1 font-mono text-[0.75rem]"
        ref={ref}
        value={search.input}
        onFocus={() => {
          if (!search.editing) setSearchInput(search.input);
        }}
        onChange={(e) => setSearchInput(e.target.value)}
        placeholder={
          search.scope === 'file' ? 'Search this file… (Enter, then n / N)' : 'Search all files… (Enter, then n / N)'
        }
        spellCheck={false}
      />
      <Button
        type="button"
        variant="ghost"
        className={twMerge(
          `rounded-sm border border-transparent px-1.5 py-[2px] font-mono text-[0.6875rem] leading-[normal] text-muted ${search.ignoreCase ? '' : 'border-accent bg-[color-mix(in_srgb,_var(--accent)_12%,_transparent)] text-accent'}`,
        )}
        aria-pressed={!search.ignoreCase}
        onClick={() => setSearchOptions({ ignoreCase: !search.ignoreCase })}
        title={search.ignoreCase ? 'Ignoring case; click to match case' : 'Matching case; click to ignore case'}
      >
        Aa
      </Button>
      <Button
        type="button"
        variant="ghost"
        className={twMerge(
          `rounded-sm border border-transparent px-1.5 py-[2px] font-mono text-[0.6875rem] leading-[normal] text-muted ${search.regex ? 'border-accent bg-[color-mix(in_srgb,_var(--accent)_12%,_transparent)] text-accent' : ''}`,
        )}
        aria-pressed={search.regex}
        onClick={() => setSearchOptions({ regex: !search.regex })}
        title={search.regex ? 'Extended regex; click for plain text' : 'Plain text; click for extended regex'}
      >
        .*
      </Button>
      <Button
        type="button"
        variant="ghost"
        className={twMerge(
          `rounded-sm border border-transparent px-1.5 py-[2px] font-mono text-[0.6875rem] leading-[normal] text-muted ${!fullFile ? '' : 'border-accent bg-[color-mix(in_srgb,_var(--accent)_12%,_transparent)] text-accent'}`,
        )}
        aria-label="Search full file"
        aria-pressed={fullFile}
        onClick={() => setSearchOptions({ content: fullFile ? 'diff' : 'full' })}
        title={
          fullFile
            ? 'Searching full file; click to search diff + context'
            : 'Searching diff + context; click to search full file'
        }
      >
        <ScopeIcon size="0.75rem" />
      </Button>
      <span className="min-w-17.5 text-right font-mono text-[0.75rem] leading-[normal] text-muted">
        {search.loading
          ? 'searching…'
          : n === 0 && search.query
            ? search.scope === 'file'
              ? 'none in file'
              : fullFile
                ? 'no matches'
                : 'none in diff'
            : n
              ? `${search.index + 1} / ${n}${search.truncated ? '+' : ''}`
              : ''}
      </span>
      <Button type="button" variant="ghost" icon onClick={closeSearch} title="Close (Esc)">
        <X size="0.875rem" />
      </Button>
    </form>
  );
}
