import { useEffect, useId, useRef, useState, type Ref } from 'react';
import type { RefsResponse } from '../../shared/protocol.js';

/** Editable revision with suggestions; arbitrary Git revisions remain valid input. */
export function RefInput({
  label,
  value,
  onChange,
  refs,
  autoFocus,
  allowWorktree,
  inputRef,
  onAccept,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  refs: RefsResponse | null;
  autoFocus?: boolean;
  allowWorktree?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  onAccept(): void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const list = useRef<HTMLDivElement>(null);
  const options = [
    { value: 'HEAD', detail: 'Current commit' },
    ...(allowWorktree ? [{ value: 'worktree', detail: 'Uncommitted changes' }] : []),
    ...(refs?.branches ?? []).map((value) => ({
      value,
      detail: value === refs?.current ? 'Current branch' : 'Branch',
    })),
    ...(refs?.remoteBranches ?? []).map((value) => ({ value, detail: 'Remote branch' })),
    ...(refs?.tags ?? []).map((value) => ({ value, detail: 'Tag' })),
    ...(refs?.recent ?? []).map((commit) => ({ value: commit.short, detail: commit.subject })),
  ]
    .filter((option, i, all) => all.findIndex((other) => other.value === option.value) === i)
    .filter((option) => `${option.value} ${option.detail}`.toLowerCase().includes(query.toLowerCase()));
  const selected = options[active];

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const choose = (revision: string) => {
    onChange(revision);
    setOpen(false);
    setActive(-1);
  };

  return (
    <div className="ref-input">
      <input
        ref={inputRef}
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open && selected ? `${id}-${active}` : undefined}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        placeholder={label}
        title={value || label}
        value={value}
        onFocus={(e) => {
          e.currentTarget.select();
          setQuery('');
          setActive(-1);
          setOpen(true);
        }}
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          onChange(e.target.value);
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            e.stopPropagation();
            setOpen(true);
            setActive((current) =>
              options.length
                ? (current + (e.key === 'ArrowDown' ? 1 : current < 0 ? 0 : -1) + options.length) % options.length
                : -1,
            );
          } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            e.stopPropagation();
            const revision = open && selected ? selected.value : value.trim();
            if (revision) {
              choose(revision);
              onAccept();
            }
          } else if (e.key === 'Escape' && open) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
      />
      {open && (
        <div
          className="ref-suggestions"
          id={id}
          role="listbox"
          tabIndex={-1}
          aria-label={`${label} suggestions`}
          ref={list}
        >
          {options.map((option, i) => (
            <div
              key={option.value}
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === active}
              className="ref-suggestion"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(option.value)}
            >
              <span className="ref-name">{option.value}</span>
              <span className="ref-detail">{option.detail}</span>
            </div>
          ))}
          {!options.length && <div className="ref-empty">Use this revision as typed.</div>}
        </div>
      )}
    </div>
  );
}
