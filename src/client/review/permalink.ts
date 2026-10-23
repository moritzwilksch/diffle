import { api } from '@/client/api.js';
import { copyText } from '@/client/clipboard.js';
import type { ResolvedRange } from '@/client/comments/anchor.js';
import { pathFromItemId, selectionRange } from '@/client/model.js';
import { useStore, type ReviewState } from '@/client/store.js';
import type { Published, Snapshot } from '@/shared/protocol.js';

export type Permalink = { url: string } | { reason: string };

/**
 * A GitHub link to `range` of `path` at the commit its side shows, or why there is none: origin
 * must be a GitHub repository holding that commit. An old-side range names a rename's old path.
 */
export function permalink(snapshot: Snapshot, published: Published, path: string, range: ResolvedRange): Permalink {
  if (published.version !== snapshot.version) return { reason: 'The review changed; try again' };
  if (!published.repositoryUrl) return { reason: 'No GitHub origin to link to' };
  const sha = range.side === 'old' ? snapshot.oldSha : snapshot.newSha;
  if (!published[range.side]) {
    if (sha === 'worktree') return { reason: 'Uncommitted lines have no GitHub link' };
    if (range.side === 'old' && snapshot.interdiff) return { reason: 'An interdiff’s old side is not on GitHub' };
    return { reason: 'Not on GitHub: these lines are not in a pushed commit' };
  }
  const file = range.side === 'old' ? (snapshot.changed.find((f) => f.path === path)?.oldPath ?? path) : path;
  const lines = range.startLine === range.endLine ? `L${range.startLine}` : `L${range.startLine}-L${range.endLine}`;
  const encoded = file.split('/').map(encodeURIComponent).join('/');
  return { url: `${published.repositoryUrl}/blob/${sha}/${encoded}#${lines}` };
}

/**
 * The permalink to the draft's lines, asked afresh so a push since shows; null for a file draft,
 * lines GitHub cannot show, or a failed lookup.
 */
export async function draftPermalink(s: ReviewState): Promise<string | null> {
  const d = s.draft;
  if (!s.snapshot || !d?.selection || s.fileView?.external) return null;
  const [snapshot, range] = [s.snapshot, selectionRange(s, d.path, d.selection)];
  const published = await api.published().catch(() => null);
  const link = published && permalink(snapshot, published, d.path, range);
  return link && 'url' in link ? link.url : null;
}

/**
 * Copies the permalink to the cursor line or selection and says so, or says why there is none.
 * Only the local refs are asked, so the copy lands while the keypress still allows it.
 */
export async function copyCursorPermalink(): Promise<void> {
  const s = useStore.getState();
  if (!s.snapshot || !s.selection) return s.flash('No line under the cursor');
  if (s.fileView?.external) return s.flash('Only repository files have GitHub links');
  const path = pathFromItemId(s.selection.id);
  const [snapshot, range] = [s.snapshot, selectionRange(s, path, s.selection)];
  let published: Published;
  try {
    published = await api.published();
  } catch (e) {
    return s.report('Looking up the GitHub link', e);
  }
  const link = permalink(snapshot, published, path, range);
  if ('reason' in link) return s.flash(link.reason);
  s.flash((await copyText(link.url)) ? 'Copied GitHub link' : 'The browser blocked clipboard access');
}
