import { copyText } from '@/client/clipboard.js';
import type { ResolvedRange } from '@/client/comments/anchor.js';
import { pathFromItemId, selectionRange } from '@/client/model.js';
import type { ReviewState } from '@/client/store.js';
import type { GithubMetadata, Snapshot } from '@/shared/protocol.js';

/**
 * A GitHub link to `range` of `path` at the commit its side shows, or why there is none: GitHub
 * must know the repository and that commit. An old-side range names a rename's old path.
 */
export function permalink(
  snapshot: Snapshot,
  github: GithubMetadata | undefined,
  path: string,
  range: ResolvedRange,
): { url: string } | { reason: string } {
  if (!github || github.version !== snapshot.version) return { reason: 'GitHub lookup still running' };
  if (!github.repositoryUrl) return { reason: 'No GitHub origin to link to' };
  if (!github.published[range.side]) return { reason: 'Not on GitHub: these lines are not in a pushed commit' };
  const sha = range.side === 'old' ? snapshot.oldSha : snapshot.newSha;
  const file = range.side === 'old' ? (snapshot.changed.find((f) => f.path === path)?.oldPath ?? path) : path;
  const lines = range.startLine === range.endLine ? `L${range.startLine}` : `L${range.startLine}-L${range.endLine}`;
  const encoded = file.split('/').map(encodeURIComponent).join('/');
  return { url: `${github.repositoryUrl}/blob/${sha}/${encoded}#${lines}` };
}

/** The permalink to the cursor line or selection, or why there is none. */
export function cursorPermalink(s: ReviewState): { url: string } | { reason: string } {
  if (!s.snapshot || !s.selection) return { reason: 'No line under the cursor' };
  if (s.fileView?.external) return { reason: 'Only repository files have GitHub links' };
  const path = pathFromItemId(s.selection.id);
  return permalink(s.snapshot, s.github.data, path, selectionRange(s, path, s.selection));
}

/** Copies a permalink and says so; a missing one says why. */
export async function copyPermalink(link: { url: string } | { reason: string }, flash: (m: string) => void) {
  if ('reason' in link) return flash(link.reason);
  flash((await copyText(link.url)) ? 'Copied GitHub link' : 'The browser blocked clipboard access');
}
