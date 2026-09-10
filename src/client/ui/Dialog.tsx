import type { ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';

/** Dialog surface and backdrop; the caller owns focus and keyboard handling. */
export function Dialog({
  label,
  onClose,
  className,
  children,
}: {
  label: string;
  onClose(): void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-label={label}
        className={twMerge(
          'w-140 max-w-[95vw] rounded-[0.625rem] border border-border bg-canvas p-4 shadow-[0_1rem_3rem_rgba(0,0,0,0.3)]',
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}
