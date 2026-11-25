import { create } from 'zustand';

export type CommentList = 'threads' | 'github';

export const commentLists = {
  threads: { title: 'Threads', key: 'L' },
  github: { title: 'GitHub comments', key: 'P' },
} as const;

export const useCommentOverlay = create<{ list: CommentList | null }>(() => ({ list: null }));

export function showCommentOverlay(list: CommentList | null): void {
  useCommentOverlay.setState({ list });
}
