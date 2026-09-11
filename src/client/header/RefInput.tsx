import { Fragment, useEffect, useId, useRef, useState, type Ref } from 'react';
import type { RefsResponse } from '../../shared/protocol.js';

/** Editable revision with suggestions; arbitrary Git revisions remain valid input. */
export function RefInput({
  label,
  value,
  onChange,
  refs,
  autoFocus,
  inputRef,
  onAccept,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  refs: RefsResponse | null;
  autoFocus?: boolean;
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
    { value: 'worktree', detail: 'Uncommitted changes', section: 'special' },
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
    <div className="group/ref relative min-w-0 flex-1">
      <input
        className="w-full min-w-0 rounded-md border border-transparent bg-surface px-1.5 py-1 text-foreground [font:inherit] focus:bg-hover focus:outline-none"
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
        }}
        onClick={() => setOpen(true)}
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
          className="absolute top-[calc(100%_+_0.375rem)] left-0 z-1 max-h-120 w-68 max-w-[calc(100vw_-_2rem)] overflow-auto rounded-md border border-border bg-canvas p-1 shadow-[0_0.375rem_1rem_rgba(0,_0,_0,_0.18)] group-last/ref:right-0 group-last/ref:left-auto"
          id={id}
          role="listbox"
          tabIndex={-1}
          aria-label={`${label} suggestions`}
          ref={list}
        >
          {options.map((option, i) => (
            <Fragment key={option.value}>
              {i > 0 && options[i - 1]!.section !== option.section && (
                <div className="mx-2 my-1 border-t border-t-border" aria-hidden="true" />
              )}
              <div
                id={`${id}-${i}`}
                role="option"
                aria-selected={i === active}
                className="flex cursor-pointer flex-col gap-0.5 rounded-sm px-2 py-1.5 hover:bg-hover aria-selected:bg-hover"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(option.value)}
              >
                <span className="truncate">{option.value}</span>
                <span className="truncate font-sans text-[0.6875rem] leading-[1.4] text-muted">{option.detail}</span>
              </div>
            </Fragment>
          ))}
          {!options.length && (
            <div className="p-2 font-sans text-[0.6875rem] leading-[1.4] text-muted">Use this revision as typed.</div>
          )}
        </div>
      )}
    </div>
  );
}
