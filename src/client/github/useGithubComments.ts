import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { api } from '@/client/api.js';
import { useStore } from '@/client/store.js';
import type { GithubComments } from '@/shared/protocol.js';
import { githubCommentsEvent } from './commentsEvent.js';

interface CommentsState {
  prUrl?: string;
  data?: GithubComments;
  error?: string;
  loading: boolean;
}

const initial: CommentsState = { loading: true };
const useComments = create<CommentsState>(() => initial);

export function useGithubComments(prUrl: string | undefined): CommentsState {
  return useComments((state) => (state.prUrl === prUrl ? state : initial));
}

/** Keep the active PR's comments available even when the sidebar is hidden. */
export function useSyncGithubComments(): void {
  const prUrl = useStore((s) => (s.snapshot?.review.kind === 'range' ? s.snapshot.review.pr?.url : undefined));
  const version = useStore((s) =>
    s.snapshot?.review.kind === 'range' && s.snapshot.review.pr ? s.snapshot.version : undefined,
  );
  const [revision, refresh] = useState(0);

  useEffect(() => {
    const reload = () => refresh((value) => value + 1);
    window.addEventListener(githubCommentsEvent, reload);
    return () => window.removeEventListener(githubCommentsEvent, reload);
  }, []);

  useEffect(() => {
    if (!prUrl) {
      useComments.setState(initial, true);
      return;
    }
    const controller = new AbortController();
    useComments.setState((s) => ({ prUrl, loading: true, data: s.prUrl === prUrl ? s.data : undefined }), true);
    void api.githubComments(controller.signal).then(
      (data) => {
        if (controller.signal.aborted) return;
        useComments.setState({ prUrl, data, loading: false }, true);
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        useComments.setState({ error: cause instanceof Error ? cause.message : String(cause), loading: false });
      },
    );
    return () => controller.abort();
  }, [prUrl, revision, version]);
}
