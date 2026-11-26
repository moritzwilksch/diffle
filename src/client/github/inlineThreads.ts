import type { HostedCommentThread, Snapshot } from '@/shared/protocol.js';
import { githubThreadKey, setInlineExpanded } from '@/client/comments/inlineExpansion.js';
import { useStore } from '@/client/store.js';
import { showView } from '@/client/views/state.js';

export interface GithubInlineThread {
  prUrl: string;
  path: string;
  thread: HostedCommentThread;
  line: number | null;
}

function lineInComparison(snapshot: Snapshot, thread: HostedCommentThread): number | null {
  if (snapshot.review.kind !== 'range' || snapshot.review.view.kind !== 'whole' || thread.headSha !== snapshot.newSha)
    return null;
  return thread.line;
}

export function showGithubThread(prUrl: string, thread: HostedCommentThread): void {
  const store = useStore.getState();
  const snap = store.snapshot;
  if (!snap || snap.review.kind !== 'range' || snap.review.pr?.url !== prUrl || thread.isOutdated) return;
  const file =
    snap.changed.find((item) => item.path === thread.path) ?? snap.changed.find((item) => item.oldPath === thread.path);
  const path = file?.path ?? thread.path;
  if (!file && !snap.tree.includes(path)) {
    store.flash('This file is outside the current comparison. Open the comment on GitHub.');
    return;
  }
  setInlineExpanded(githubThreadKey(thread.id), true, !thread.isResolved);
  const side = thread.side;
  const line = !file && side === 'old' ? null : lineInComparison(snap, thread);
  showView('diff');
  void store.openFile(path, line ?? undefined, side);
}

export function githubThreadsByPath(
  snapshot: Snapshot,
  threads: readonly HostedCommentThread[],
): Map<string, GithubInlineThread[]> {
  const byPath = new Map<string, GithubInlineThread[]>();
  if (snapshot.review.kind !== 'range' || !snapshot.review.pr) return byPath;
  const prUrl = snapshot.review.pr.url;
  const changed = new Set(snapshot.changed.map(({ path }) => path));
  const renamed = new Map(
    snapshot.changed.filter(({ oldPath }) => oldPath).map(({ oldPath, path }) => [oldPath, path]),
  );
  for (const thread of threads) {
    if (thread.isOutdated) continue;
    const path = changed.has(thread.path) ? thread.path : (renamed.get(thread.path) ?? thread.path);
    const entry = { prUrl, path, thread, line: lineInComparison(snapshot, thread) };
    const existing = byPath.get(path);
    if (existing) existing.push(entry);
    else byPath.set(path, [entry]);
  }
  return byPath;
}
