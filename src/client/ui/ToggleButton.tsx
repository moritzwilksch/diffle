import type { ComponentProps } from 'react';
import { twMerge } from 'tailwind-merge';
import { Button } from './Button.js';

/**
 * A recessed track holding `ToggleButton`s. Its 2px inset matches `Button`'s height, so a control sits
 * flush with the buttons beside it.
 */
export function SegmentedControl({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div {...props} className={twMerge('inline-flex items-center gap-0.5 rounded-md bg-hover p-0.5', className)} />
  );
}

/** A pressed choice inside a `SegmentedControl`: the selected one rises as a raised pill. */
export function ToggleButton({ selected, className, ...props }: ComponentProps<'button'> & { selected: boolean }) {
  return (
    <Button
      {...props}
      aria-pressed={selected}
      className={twMerge(
        'rounded-[0.25rem] border-0 bg-transparent px-2 py-0.5 text-muted hover:bg-transparent hover:text-foreground',
        selected && 'bg-raised text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.12)] hover:bg-raised',
        className,
      )}
    />
  );
}
