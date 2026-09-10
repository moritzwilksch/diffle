import type { ComponentProps } from 'react';
import { twMerge } from 'tailwind-merge';

type ButtonProps = ComponentProps<'button'> & {
  variant?: 'default' | 'primary' | 'ghost';
  danger?: boolean;
  icon?: boolean;
  feedback?: 'confirm' | 'posted' | 'copied';
};

/** Shared review controls; callers can override layout with utility classes. */
export function Button({ variant = 'default', danger, icon, feedback, className, ...props }: ButtonProps) {
  return (
    <button
      {...props}
      data-feedback={feedback}
      className={twMerge(
        'inline-flex cursor-pointer items-center gap-1.25 rounded-md border border-border bg-surface px-2.25 py-0.75 leading-[1.2] hover:bg-hover disabled:cursor-default disabled:opacity-50 [&_svg]:flex-none',
        variant === 'primary' && 'border-transparent bg-accent text-accent-fg hover:bg-accent',
        variant === 'ghost' && 'border-transparent bg-transparent hover:bg-hover',
        danger && 'text-danger',
        icon && 'px-1.25',
        feedback === 'confirm' &&
          (danger
            ? 'border-transparent bg-danger text-white hover:bg-danger'
            : 'border-transparent bg-accent text-accent-fg hover:bg-accent'),
        feedback === 'posted' && 'border-transparent bg-add text-canvas hover:bg-add',
        feedback === 'copied' && 'border-transparent bg-add text-white hover:bg-add',
        className,
      )}
    />
  );
}
