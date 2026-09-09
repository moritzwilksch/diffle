import type { FileTree, FileTreeDirectoryHandle, GitStatusEntry } from '@pierre/trees';
import type { ChangedFile } from '../../shared/protocol.js';
import type { ReviewState } from '../store.js';
import { viewedState } from '../model.js';

/** Every ancestor directory of `paths`, without trailing slash, in first-seen order. */
export function directoriesOf(paths: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const p of paths) {
    for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) dirs.add(p.slice(0, i));
  }
  return [...dirs];
}

/**
 * Directories to expand after `model.resetPaths(next)`: folders the reader already has keep
 * their state, folders new to the tree open. `resetPaths` rebuilds the store from scratch, so
 * without this list the reader's collapsed folders would spring open on every save.
 */
export function expandedAfterReset(model: Pick<FileTree, 'getItem'>, next: readonly string[]): string[] {
  const expanded: string[] = [];
  for (const dir of directoriesOf(next)) {
    const item = model.getItem(dir);
    if (!item || !item.isDirectory() || (item as FileTreeDirectoryHandle).isExpanded()) expanded.push(dir);
  }
  return expanded;
}

/** The tree's four-valued git lane for a changed file; T and U draw as modified, C as renamed. */
export function toGitStatus(f: ChangedFile): GitStatusEntry {
  const status =
    f.status === 'A'
      ? 'added'
      : f.status === 'D'
        ? 'deleted'
        : f.status === 'R' || f.status === 'C'
          ? 'renamed'
          : 'modified';
  return { path: f.path, status };
}

/**
 * Signature of the git-status lane as the tree sees it. It must hash the mapped status, not
 * the raw one: `setGitStatus` no-ops when its own signature over the mapped values is
 * unchanged, so a key that differed for M -> T would take the status branch and draw nothing.
 */
export function statusKey(changed: readonly ChangedFile[]): string {
  return changed.map((f) => `${f.path}\0${toGitStatus(f).status}`).join('\n');
}

/**
 * Signature of everything the decoration lane shows (counts, viewed marks). Rows read live
 * state when drawn, so the tree only needs a redraw when this changes; a viewed-list refresh
 * or a config save that leaves the marks alone must not redraw the tree.
 */
export function decorationKey(state: Pick<ReviewState, 'viewed' | 'config'>, changed: readonly ChangedFile[]): string {
  return changed
    .map((f) => `${f.path}\0${f.additions}\0${f.deletions}\0${f.binary ? 1 : 0}\0${viewedState(state, f)}`)
    .join('\n');
}

/** Content signatures of the three things the tree shows; compared across renders by `syncStep`. */
export interface SyncKeys {
  paths: string;
  status: string;
  decoration: string;
}

export type SyncStep = 'reset' | 'status' | 'decoration' | 'none';

/**
 * The cheapest model update that redraws every row whose content changed between `prev` and
 * `next`. `paths` and `gitStatus` are fresh arrays per snapshot, so callers compare by content:
 * `resetPaths` rebuilds the tree and would re-open collapsed folders, `setGitStatus` redraws
 * the rows only when its signature moves, and a composition re-apply covers the decorations.
 */
export function syncStep(prev: SyncKeys | null, next: SyncKeys): SyncStep {
  if (!prev) return 'none'; // the constructor applied the first snapshot
  if (prev.paths !== next.paths) return 'reset';
  if (prev.status !== next.status) return 'status';
  if (prev.decoration !== next.decoration) return 'decoration';
  return 'none';
}
