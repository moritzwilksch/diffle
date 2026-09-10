import { Fragment, useEffect, useId, useRef, useState, type Ref } from 'react';
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
    { value: 'HEAD', detail: 'Current commit', section: 'special' },
    ...(allowWorktree ? [{ value: 'worktree', detail: 'Uncommitted changes', section: 'special' }] : []),
    ...(refs?.branches ?? []).map((value) => ({
      value,
      detail: value === refs?.current ? 'Current branch' : 'Branch',
      section: 'branches',
    })),
    ...(refs?.remoteBranches ?? []).map((value) => ({ value, detail: 'Remote branch', section: 'remotes' })),
    ...(refs?.tags ?? []).map((value) => ({ value, detail: 'Tag', section: 'tags' })),
    ...(refs?.recent ?? []).map((commit) => ({ value: commit.short, detail: commit.subject, section: 'commits' })),
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
    <div className="group/ref relative flex-1 min-w-0">
      <input
        className="w-full min-w-0 bg-surface border rounded-md py-1 px-1.5 [font:inherit] text-foreground border-transparent focus:outline-none focus:bg-hover"
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
          className="absolute top-[calc(100%_+_0.375rem)] left-0 w-68 max-w-[calc(100vw_-_2rem)] max-h-120 overflow-auto p-1 border border-border rounded-md bg-canvas shadow-[0_0.375rem_1rem_rgba(0,_0,_0,_0.18)] z-1 group-last/ref:left-auto group-last/ref:right-0"
          id={id}
          role="listbox"
          tabIndex={-1}
          aria-label={`${label} suggestions`}
          ref={list}
        >
          {options.map((option, i) => (
            <Fragment key={option.value}>
              {i > 0 && options[i - 1]!.section !== option.section && (
                <div className="border-t border-t-border my-1 mx-2" aria-hidden="true" />
              )}
              <div
                id={`${id}-${i}`}
                role="option"
                aria-selected={i === active}
                className="flex flex-col gap-0.5 py-1.5 px-2 rounded cursor-pointer hover:bg-hover aria-selected:bg-hover"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(option.value)}
              >
                <span className="truncate">{option.value}</span>
                <span className="truncate text-muted font-sans text-[0.6875rem] leading-[1.4]">{option.detail}</span>
              </div>
            </Fragment>
          ))}
          {!options.length && (
            <div className="text-muted font-sans text-[0.6875rem] leading-[1.4] p-2">Use this revision as typed.</div>
          )}
        </div>
      )}
    </div>
  );
}
