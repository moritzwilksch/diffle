import { EventEmitter } from 'node:events';
import { join, relative, sep } from 'node:path';
import type { FSWatcher } from 'chokidar';

export type WatchTarget =
  | {
      kind: 'worktree';
      root: string;
      gitDir: string;
      commonDir: string;
      /** Repo-relative paths git ignores (files and directories). Refreshed by the owner. */
      ignored: () => ReadonlySet<string>;
    }
  | { kind: 'refs'; gitDir: string; commonDir: string };

/**
 * Owns chokidar. Debounces fs events into one `dirty` signal. Git metadata
 * (HEAD, refs, and in worktree mode the index) is watched by its own chokidar
 * instance: the worktree watcher's `ignored` excludes everything under the git
 * dir, and chokidar applies it to explicitly added paths too.
 */
export class Watcher extends EventEmitter<{ dirty: [] }> {
  private watcher: FSWatcher | null = null;
  private meta: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly target: WatchTarget,
    private readonly debounceMs = 150,
  ) {
    super();
  }

  async start(): Promise<void> {
    const { watch } = await import('chokidar');
    const t = this.target;
    if (t.kind === 'worktree') {
      const gitDirRel = relative(t.root, t.gitDir);
      this.watcher = watch(t.root, {
        ignoreInitial: true,
        ignorePermissionErrors: true,
        ignored: (abs: string) => {
          const rel = relative(t.root, abs);
          if (rel === '') return false;
          if (rel === '.git' || rel.startsWith(`.git${sep}`)) return true;
          if (gitDirRel && !gitDirRel.startsWith('..') && (rel === gitDirRel || rel.startsWith(gitDirRel + sep)))
            return true;
          const posix = rel.split(sep).join('/');
          const ignored = t.ignored();
          if (ignored.has(posix) || ignored.has(posix + '/')) return true;
          // Ignored directories are listed with a trailing slash.
          let i = posix.indexOf('/');
          while (i !== -1) {
            if (ignored.has(posix.slice(0, i + 1))) return true;
            i = posix.indexOf('/', i + 1);
          }
          return false;
        },
      });
      this.watcher.on('all', (_event, path) => this.schedule(path));
      this.watcher.on('error', (err) => console.error('[diffle] watcher error:', err));
    }
    // Git atomically replaces metadata files; native file watches can lose those events.
    this.meta = watch(metaPaths(t), {
      ignoreInitial: true,
      ignorePermissionErrors: true,
      usePolling: true,
      interval: 100,
    });
    this.meta.on('all', (_event, path) => this.schedule(path));
    this.meta.on('error', (err) => console.error('[diffle] watcher error:', err));
    // A handful of paths: waiting for the scan makes "started" mean "observing".
    await new Promise<void>((resolve) => this.meta!.once('ready', resolve));
  }

  private schedule(path: string): void {
    // Git writes lock files next to refs; ignore them so a commit yields one refresh.
    if (path.endsWith('.lock') && this.isGitInternal(path)) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.emit('dirty');
    }, this.debounceMs);
  }

  private isGitInternal(path: string): boolean {
    const t = this.target;
    const dirs = [t.gitDir, t.commonDir];
    return dirs.some((d) => path === d || path.startsWith(d + sep));
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    await Promise.all([this.watcher?.close(), this.meta?.close()]);
    this.watcher = null;
    this.meta = null;
  }
}

/**
 * Git metadata the snapshot depends on. HEAD and refs move the old side in
 * every live mode; in worktree mode the index also decides the tree and the
 * changed set (`git add -f`, `git rm --cached`), and it is replaced atomically
 * via `index.lock`. Polling keeps observing the path across replacements.
 */
function metaPaths(t: WatchTarget): string[] {
  const paths = refPaths(t.gitDir, t.commonDir);
  if (t.kind === 'worktree') paths.push(join(t.gitDir, 'index'));
  return paths;
}

function refPaths(gitDir: string, commonDir: string): string[] {
  return [
    ...new Set([
      join(gitDir, 'HEAD'),
      join(commonDir, 'HEAD'),
      join(commonDir, 'refs'),
      join(commonDir, 'packed-refs'),
    ]),
  ];
}
