import { File, Folder } from 'lucide-react';
import { useStore } from '@/client/store.js';
import { jump } from '@/client/tour/state.js';
import type { ChangeStatus } from '@/shared/protocol.js';
import type { Place } from '@/client/tour/anchor.js';

interface Dir {
  dirs: Map<string, Dir>;
  files: string[];
}

const STATUS_COLOR: Partial<Record<ChangeStatus, string>> = { A: 'var(--add)', D: 'var(--del)' };

/** A directory tree of `paths` under `root`; a changed file shows its status and opens in the diff. */
export function TourTree({ paths, root, place }: { paths: string; root: string; place?: Place }) {
  const changed = useStore((s) => s.snapshot?.changed);
  const status = new Map(changed?.map((f) => [f.path, f.status]));
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
        const s = status.get(path);
        return (
          <li key={path}>
            <button
              type="button"
              className="inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 font-mono text-[0.75rem] text-foreground hover:underline"
              onClick={() => void jump(path)}
            >
              <File size="0.75rem" className="text-muted" />
              {path.slice(path.lastIndexOf('/') + 1)}
              {s && (
                <span className="font-semibold" style={{ color: STATUS_COLOR[s] ?? 'var(--accent)' }}>
                  {s}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
  return (
    <div
      {...place}
      data-opaque=""
      className="tour-block rounded-md border border-border bg-canvas py-1.5 pr-2 font-mono text-[0.75rem] [&>ul]:pl-2"
    >
      {root && <div className="pl-2 text-muted">{root}/</div>}
      {level(top)}
    </div>
  );
}
