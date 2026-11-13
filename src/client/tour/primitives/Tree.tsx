import { File, Folder } from 'lucide-react';
import { type ReactNode, useMemo } from 'react';
import { useStore } from '@/client/store.js';
import { jump } from '@/client/tour/state.js';
import type { ChangeStatus } from '@/shared/protocol.js';
import { TourIcon } from './Icon.js';

interface Dir {
  dirs: Map<string, Dir>;
  files: string[];
}

const FILE = 'inline-flex items-center gap-1 border-0 bg-transparent p-0 font-mono text-[0.75rem] text-foreground';
const STATUS_COLOR: Partial<Record<ChangeStatus, string>> = { A: 'var(--add)', D: 'var(--del)' };

/**
 * A directory tree of `paths` under `root`, headed by its title and icon as a card is; a changed
 * file shows its status and its lines added and removed, and opens in the diff where there is one.
 * A few files carry a note beside their name.
 */
export function TourTree({
  paths,
  root,
  title,
  icon,
  notes,
}: {
  paths: string;
  root: string;
  title: string;
  icon?: string;
  /** A few words beside some files, by path. */
  notes: ReadonlyMap<string, ReactNode>;
}) {
  const changed = useStore((s) => s.snapshot?.changed);
  const files = useMemo(() => new Map(changed?.map((f) => [f.path, f])), [changed]);
  const top: Dir = { dirs: new Map(), files: [] };
  const prefix = root ? `${root}/` : '';
  for (const path of paths.split('\n').map((p) => p.trim())) {
    if (!path || !path.startsWith(prefix)) continue;
    const parts = path.slice(prefix.length).split('/');
    let dir = top;
    for (const part of parts.slice(0, -1)) {
      if (!dir.dirs.has(part)) dir.dirs.set(part, { dirs: new Map(), files: [] });
      dir = dir.dirs.get(part)!;
    }
    dir.files.push(path);
  }
  const level = (dir: Dir) => (
    <ul className="m-0 list-none pl-3.5">
      {[...dir.dirs].map(([name, sub]) => (
        <li key={name}>
          <span className="inline-flex items-center gap-1 text-muted">
            <Folder size="0.75rem" /> {name}/
          </span>
          {level(sub)}
        </li>
      ))}
      {dir.files.map((path) => {
        const file = files.get(path);
        const s = file?.status;
        const note = notes.get(path);
        const name = (
          <>
            <File size="0.75rem" className="text-muted" />
            {path.slice(path.lastIndexOf('/') + 1)}
            {s && (
              <span className="font-semibold" style={{ color: STATUS_COLOR[s] ?? 'var(--accent)' }}>
                {s}
              </span>
            )}
            {file && file.additions + file.deletions > 0 && (
              <span className="text-muted">
                {[file.additions && `+${file.additions}`, file.deletions && `−${file.deletions}`]
                  .filter(Boolean)
                  .join(' ')}
              </span>
            )}
          </>
        );
        return (
          <li key={path} className="flex items-baseline gap-2">
            <button type="button" className={`${FILE} cursor-pointer hover:underline`} onClick={() => void jump(path)}>
              {name}
            </button>
            {note && <span className="tour-tree-note">{note}</span>}
          </li>
        );
      })}
    </ul>
  );
  return (
    <div className="tour-block overflow-hidden rounded-md border border-border bg-canvas">
      <div className="tour-tree-title">
        {icon && <TourIcon name={icon} />}
        {title}
      </div>
      <div className="py-1.5 pr-2 font-mono text-[0.75rem] [&>ul]:pl-2">
        {root && <div className="pl-2 text-muted">{root}/</div>}
        {level(top)}
      </div>
    </div>
  );
}
