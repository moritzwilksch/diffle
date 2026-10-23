import { copyText } from '@/client/clipboard.js';
import type { ResolvedRange } from '@/client/comments/anchor.js';
import { pathFromItemId, selectionRange } from '@/client/model.js';
import { useStore, type GithubState, type ReviewState } from '@/client/store.js';
import type { Snapshot } from '@/shared/protocol.js';

/** A link, or why there is none; `unpushed` when a push since the lookup could supply one. */
export type Permalink = { url: string } | { reason: string; unpushed?: true };

/**
 * A GitHub link to `range` of `path` at the commit its side shows, or why there is none: GitHub
 * must know the repository and that commit. An old-side range names a rename's old path.
 */
export function permalink(snapshot: Snapshot, github: GithubState, path: string, range: ResolvedRange): Permalink {
  if (github.status === 'error') return { reason: `GitHub lookup failed: ${github.error}` };
  if (github.status === 'idle') return { reason: 'No GitHub lookup yet' };
  if (github.status !== 'ready' || github.data.version !== snapshot.version) {
    return { reason: 'GitHub lookup still running' };
  }
  const { repositoryUrl, published } = github.data;
  if (!repositoryUrl) return { reason: 'No GitHub origin to link to' };
  const sha = range.side === 'old' ? snapshot.oldSha : snapshot.newSha;
  if (!published[range.side]) {
    if (sha === 'worktree') return { reason: 'Uncommitted lines have no GitHub link' };
    if (range.side === 'old' && snapshot.interdiff) return { reason: 'An interdiff’s old side is not on GitHub' };
    return { reason: 'Not on GitHub: these lines are not in a pushed commit', unpushed: true };
  }
  const file = range.side === 'old' ? (snapshot.changed.find((f) => f.path === path)?.oldPath ?? path) : path;
  const lines = range.startLine === range.endLine ? `L${range.startLine}` : `L${range.startLine}-L${range.endLine}`;
  const encoded = file.split('/').map(encodeURIComponent).join('/');
  return { url: `${repositoryUrl}/blob/${sha}/${encoded}#${lines}` };
}

/** The permalink to the cursor line or selection, or why there is none. */
function cursorPermalink(s: ReviewState): Permalink {
  if (!s.snapshot || !s.selection) return { reason: 'No line under the cursor' };
  if (s.fileView?.external) return { reason: 'Only repository files have GitHub links' };
  const path = pathFromItemId(s.selection.id);
  return permalink(s.snapshot, s.github, path, selectionRange(s, path, s.selection));
}

/** The permalink to the draft's lines; null for a file draft or none at all. */
export function draftPermalink(s: ReviewState): Permalink | null {
  const d = s.draft;
  if (!s.snapshot || !d?.selection || s.fileView?.external) return null;
  return permalink(s.snapshot, s.github, d.path, selectionRange(s, d.path, d.selection));
}

/**
 * Copies the permalink to the cursor line or selection and says so, or says why there is none.
 * Lines in an unpushed commit look again first: it may have been pushed since the last lookup.
 */
export async function copyCursorPermalink(): Promise<void> {
  const s = useStore.getState();
  let link = cursorPermalink(s);
  if ('unpushed' in link) {
    await s.refreshGithub();
    link = cursorPermalink(useStore.getState());
  }
  if ('reason' in link) return s.flash(link.reason);
  s.flash((await copyText(link.url)) ? 'Copied GitHub link' : 'The browser blocked clipboard access');
}
