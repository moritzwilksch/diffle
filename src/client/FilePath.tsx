import { twMerge } from 'tailwind-merge';
import { Fragment } from 'react';

/**
 * A repository path in monospace. Directories are dim, the file name is bold, and
 * line breaks are offered after each `/` so wrapping happens between path
 * elements first; a single overlong element still breaks as a last resort.
 */
export function FilePath({ path, className, nowrap = false }: { path: string; className?: string; nowrap?: boolean }) {
  const cut = path.lastIndexOf('/') + 1;
  const dirs = path.slice(0, cut).split('/').filter(Boolean);
  const base = path.slice(cut);
  return (
    <span
      className={twMerge('font-mono break-normal wrap-anywhere', nowrap && 'min-w-0 truncate', className)}
      title={path}
    >
      {dirs.length > 0 && (
        <span className="text-muted">
          {dirs.map((d, i) => (
            <Fragment key={i}>
              {d}/<wbr />
            </Fragment>
          ))}
        </span>
      )}
      <span className="font-semibold text-foreground">{base}</span>
    </span>
  );
}
