import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';

/** Keeps the button width stable while its icon acknowledges a successful copy. */
export function CopyIcon({ done, children, size = '0.875rem' }: { done: boolean; children: ReactNode; size?: string }) {
  const transition =
    'absolute inset-0 inline-flex items-center justify-center [transition:opacity_160ms_ease,transform_200ms_cubic-bezier(0.2,0.8,0.2,1)]';
  return (
    <span className="relative inline-block size-3.5" aria-hidden="true">
      <span className={twMerge(transition, done && '[transform:scale(0.4)] opacity-0')}>{children}</span>
      <span
        className={twMerge(
          transition,
          done ? '[transform:scale(1)_rotate(0)] opacity-100' : '[transform:scale(0.4)_rotate(-30deg)] opacity-0',
        )}
      >
        <Check size={size} />
      </span>
    </span>
  );
}
