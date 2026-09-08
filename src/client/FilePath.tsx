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
    <span className={`filepath${nowrap ? ' nowrap' : ''}${className ? ` ${className}` : ''}`} title={path}>
      {dirs.length > 0 && (
        <span className="dir">
          {dirs.map((d, i) => (
            <Fragment key={i}>
              {d}/<wbr />
            </Fragment>
          ))}
        </span>
      )}
      <span className="base">{base}</span>
    </span>
  );
}
