import { Button } from '../ui/Button.js';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';

/** A nonnegative integer ancestor offset, or null while the input is incomplete or invalid. */
export function parseOffset(value: string): number | null {
  const n = Number(value);
  return /^[0-9]+$/.test(value) && Number.isSafeInteger(n) ? n : null;
}

/** An editable ancestor offset with mouse and keyboard stepping. */
export function CommitOffsetInput({
  label,
  value,
  onChange,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  autoFocus?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const select = useRef(false);
  useLayoutEffect(() => {
    if (!select.current) return;
    input.current?.focus();
    input.current?.select();
    select.current = false;
  }, [value]);
  const step = (delta: number) => {
    const next = String(Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, (parseOffset(value) ?? 0) + delta)));
    select.current = next !== value;
    onChange(next);
    input.current?.focus();
    input.current?.select();
  };
  return (
    <div className="mx-0.5 my-0 inline-flex items-stretch overflow-hidden rounded-md bg-surface focus-within:bg-hover">
      <input
        className="m-0 box-content w-full max-w-[8ch] min-w-[1ch] flex-[0_1_auto] rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-center text-foreground [font:inherit] focus:outline-none"
        ref={input}
        type="text"
        inputMode="numeric"
        pattern="[0-9]+"
        required
        aria-label={label}
        aria-invalid={parseOffset(value) === null}
        autoFocus={autoFocus}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          e.preventDefault();
          e.stopPropagation();
          step(e.key === 'ArrowUp' ? 1 : -1);
        }}
        value={value}
        style={{ width: `${Math.max(1, value.length)}ch` }}
        onChange={(e) => {
          if (/^[0-9]*$/.test(e.target.value)) onChange(e.target.value);
        }}
      />
      <div className="grid grid-rows-[1fr_1fr]">
        <Button
          className="rounded-none border-0 bg-transparent px-0.75 py-0 leading-[1] text-muted hover:bg-surface hover:text-foreground"
          type="button"
          tabIndex={-1}
          aria-label={`Increase ${label.toLowerCase()}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => step(1)}
        >
          <ChevronUp size="0.625rem" />
        </Button>
        <Button
          className="rounded-none border-0 bg-transparent px-0.75 py-0 leading-[1] text-muted hover:bg-surface hover:text-foreground"
          type="button"
          tabIndex={-1}
          aria-label={`Decrease ${label.toLowerCase()}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => step(-1)}
        >
          <ChevronDown size="0.625rem" />
        </Button>
      </div>
    </div>
  );
}
