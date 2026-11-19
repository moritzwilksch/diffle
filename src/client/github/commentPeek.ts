import type { CodeViewItem } from '@pierre/diffs';
import { create } from 'zustand';
import type { GithubCommentMessage, GithubComments, GithubCommentThread } from '@/shared/protocol.js';
import { useStore } from '@/client/store.js';
import { showView } from '@/client/views/state.js';
import type { Annot } from '@/client/review/ReviewPane.js';

export interface GithubPeek {
  prUrl: string;
  version: number;
  path: string;
  line: number | null;
  side: 'old' | 'new';
  message: GithubCommentMessage;
}

export const useGithubPeek = create<{ peek: GithubPeek | null }>(() => ({ peek: null }));

export function closeGithubPeek(id: string): void {
  if (useGithubPeek.getState().peek?.message.id === id) useGithubPeek.setState({ peek: null });
}

export function refreshGithubPeek(prUrl: string, comments: GithubComments): void {
  const { peek } = useGithubPeek.getState();
  if (peek?.prUrl !== prUrl) return;
  for (const thread of comments.threads) {
    const message = thread.comments.find((candidate) => candidate.id === peek.message.id);
    if (!message) continue;
    useGithubPeek.setState({ peek: { ...peek, message } });
    return;
  }
  closeGithubPeek(peek.message.id);
}

export function showGithubComment(prUrl: string, thread: GithubCommentThread, message: GithubCommentMessage): void {
  const store = useStore.getState();
  const snap = store.snapshot;
  if (!snap || snap.review.kind !== 'range' || snap.review.pr?.url !== prUrl) return;
  const file = snap.changed.find((item) => item.path === thread.path || item.oldPath === thread.path);
  const path = file?.path ?? thread.path;
  if (!file && !snap.tree.includes(path)) {
    store.flash('This file is outside the current comparison. Open the comment on GitHub.');
    return;
  }
  const side = thread.diffSide === 'LEFT' ? 'old' : 'new';
  const line = thread.isOutdated || (!file && side === 'old') ? null : thread.line;
  useGithubPeek.setState({ peek: { prUrl, version: snap.version, path, line, side, message } });
  showView('diff');
  void store.openFile(path, line ?? undefined, side);
}

/** Adds a single transient card to the viewer without changing the local thread list. */
export function withGithubPeek(
  item: CodeViewItem<Annot> | null,
  peek: GithubPeek | null,
  deleted: boolean,
): CodeViewItem<Annot> | null {
  if (!item || !peek) return item;
  const metadata: Annot = { kind: 'github', peek };
  if (item.type === 'diff') {
    const old = peek.side === 'old';
    const line = peek.line;
    const inHunk =
      line != null &&
      item.fileDiff.hunks.some((h) => {
        const start = old ? h.deletionStart : h.additionStart;
        return line >= start && line < start + (old ? h.deletionCount : h.additionCount);
      });
    const side = inHunk ? (old ? 'deletions' : 'additions') : deleted ? 'deletions' : 'additions';
    return { ...item, annotations: [...(item.annotations ?? []), { lineNumber: inHunk ? line : 0, side, metadata }] };
  }
  const lineNumber = item.file.contents && peek.side === 'new' ? (peek.line ?? 0) : 0;
  return { ...item, annotations: [...(item.annotations ?? []), { lineNumber, metadata }] };
}
