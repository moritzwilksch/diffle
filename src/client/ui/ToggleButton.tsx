import type { ComponentProps } from 'react';
import { twMerge } from 'tailwind-merge';
import { Button } from './Button.js';

/** A pressed choice inside a segmented control. */
export function ToggleButton({ selected, className, ...props }: ComponentProps<'button'> & { selected: boolean }) {
  return (
    <Button
      {...props}
      aria-pressed={selected}
      className={twMerge(
        'rounded-none border-0 bg-transparent px-2 py-[2px]',
        selected && 'bg-hover font-semibold',
        className,
      )}
    />
  );
}
