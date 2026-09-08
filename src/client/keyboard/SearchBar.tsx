import { FileDiff, FileSearch, FolderSearch, Link2, Search, WholeWord, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { SearchScope } from '../../shared/protocol.js';
import { nextSearchScope } from '../model.js';
import { useStore } from '../store.js';

const SCOPE_LABEL: Record<SearchScope, string> = { file: 'the current file', diff: 'only the diff', repo: 'the full codebase' };
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
      <div className="searchbar">
        {search.kind === 'references' ? <Link2 size="0.875rem" /> : <WholeWord size="0.875rem" />}
        <span className="label">
          {search.kind === 'references' ? 'references to' : search.direction === 1 ? 'occurrences of' : 'occurrences (upwards) of'} <code>{search.query}</code>
        </span>
        <span className="status">{search.loading ? 'searching…' : n ? `${search.index + 1} / ${n}${search.truncated ? '+' : ''}` : 'none'}</span>
        <button type="button" className="ghost icon" onClick={closeSearch} title="Close (Esc)">
          <X size="0.875rem" />
        </button>
      </div>
    );
  }
  const ScopeIcon = SCOPE_ICON[search.scope];
  return (
    <form
      className="searchbar"
      onSubmit={(e) => {
        e.preventDefault();
        void runSearch(q).then(() => {
          ref.current?.blur();
          document.querySelector<HTMLElement>('main.review')?.focus({ preventScroll: true });
        });
      }}
    >
      <Search size="0.875rem" />
      <input ref={ref} value={q} onChange={(e) => setQ(e.target.value)} placeholder={search.scope === 'file' ? 'Search this file… (Enter, then n / N)' : 'Search file contents… (Enter, then n / N)'} spellCheck={false} />
      <button
        type="button"
        className={`ghost opt ${search.ignoreCase ? '' : 'active'}`}
        aria-pressed={!search.ignoreCase}
        onClick={() => setSearchOptions({ ignoreCase: !search.ignoreCase })}
        title={search.ignoreCase ? 'Ignoring case; click to match case' : 'Matching case; click to ignore case'}
      >
        Aa
      </button>
      <button
        type="button"
        className={`ghost opt ${search.regex ? 'active' : ''}`}
        aria-pressed={search.regex}
        onClick={() => setSearchOptions({ regex: !search.regex })}
        title={search.regex ? 'Extended regex; click for plain text' : 'Plain text; click for extended regex'}
      >
        .*
      </button>
      <button
        type="button"
        className={`ghost opt ${search.scope === 'diff' ? '' : 'active'}`}
        aria-label={`Searching ${SCOPE_LABEL[search.scope]}`}
        data-scope={search.scope}
        onClick={() => setSearchOptions({ scope: nextSearchScope(search.scope) })}
        title={`Searching ${SCOPE_LABEL[search.scope]}; click to search ${SCOPE_LABEL[nextSearchScope(search.scope)]}`}
      >
        <ScopeIcon size="0.75rem" />
      </button>
      <span className="status">
        {search.loading ? 'searching…' : n === 0 && search.query ? (search.scope === 'file' ? 'none in file' : search.scope === 'diff' ? 'none in diff' : 'no matches') : n ? `${search.index + 1} / ${n}${search.truncated ? '+' : ''}` : ''}
      </span>
      <button type="button" className="ghost icon" onClick={closeSearch} title="Close (Esc)">
        <X size="0.875rem" />
      </button>
    </form>
  );
}
