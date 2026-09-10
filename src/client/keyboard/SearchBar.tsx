import { twMerge } from 'tailwind-merge';
import { Button } from '../ui/Button.js';
import { FileDiff, FileSearch, FolderSearch, Link2, Search, WholeWord, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { SearchScope } from '../../shared/protocol.js';
import { nextSearchScope } from '../model.js';
import { useStore } from '../store.js';

const SCOPE_LABEL: Record<SearchScope, string> = {
  file: 'the current file',
  diff: 'only the diff',
  repo: 'the full codebase',
};
const SCOPE_ICON: Record<SearchScope, typeof FileSearch> = { file: FileSearch, diff: FileDiff, repo: FolderSearch };

/** Content search (/ in the current file, g/ across the diff or codebase), the references of a symbol (gA), or a word's occurrences (* / #). Enter runs a search; n / N step through matches. */
export function SearchBar() {
  const search = useStore((s) => s.search);
  const runSearch = useStore((s) => s.runSearch);
  const closeSearch = useStore((s) => s.closeSearch);
  const setSearchOptions = useStore((s) => s.setSearchOptions);
  const [q, setQ] = useState(search.query);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (search.open) ref.current?.focus();
  }, [search.open, search.focusNonce]);

  if (!search.open) return null;
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
  const ScopeIcon = SCOPE_ICON[search.scope];
  return (
    <form
      className="flex items-center gap-2 border-b border-b-border bg-surface px-2.5 py-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        void runSearch(q).then(() => {
          ref.current?.blur();
          document.querySelector<HTMLElement>('main[tabindex]')?.focus({ preventScroll: true });
        });
      }}
    >
      <Search size="0.875rem" />
      <input
        className="flex-1 rounded-md border border-border bg-canvas px-2 py-1 font-mono text-[0.75rem]"
        ref={ref}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={
          search.scope === 'file'
            ? 'Search this file… (Enter, then n / N)'
            : 'Search file contents… (Enter, then n / N)'
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
          `rounded-sm border border-transparent px-1.5 py-[2px] font-mono text-[0.6875rem] leading-[normal] text-muted ${search.scope === 'diff' ? '' : 'border-accent bg-[color-mix(in_srgb,_var(--accent)_12%,_transparent)] text-accent'}`,
        )}
        aria-label={`Searching ${SCOPE_LABEL[search.scope]}`}
        data-scope={search.scope}
        onClick={() => setSearchOptions({ scope: nextSearchScope(search.scope) })}
        title={`Searching ${SCOPE_LABEL[search.scope]}; click to search ${SCOPE_LABEL[nextSearchScope(search.scope)]}`}
      >
        <ScopeIcon size="0.75rem" />
      </Button>
      <span className="min-w-17.5 text-right font-mono text-[0.75rem] leading-[normal] text-muted">
        {search.loading
          ? 'searching…'
          : n === 0 && search.query
            ? search.scope === 'file'
              ? 'none in file'
              : search.scope === 'diff'
                ? 'none in diff'
                : 'no matches'
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
