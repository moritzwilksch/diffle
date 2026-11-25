import { Dialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { useRef, useState, type RefObject } from 'react';
import { ThreadsPanel } from '@/client/comments/CommentPanel.js';
import { GithubCommentList } from '@/client/github/GithubCommentsPanel.js';
import { ReviewPane } from '@/client/review/ReviewPane.js';
import { useStore } from '@/client/store.js';
import { useTour } from '@/client/tour/state.js';
import { Button } from '@/client/ui/Button.js';
import { commentLists, showCommentOverlay, useCommentOverlay, type CommentList } from './state.js';

const close = () => showCommentOverlay(null);

function CommentDialog({
  list,
  open,
  container,
  children,
}: {
  list: CommentList;
  open: boolean;
  container: RefObject<HTMLDivElement | null>;
  children: React.ReactNode;
}) {
  const { title } = commentLists[list];
  return (
    <Dialog.Root open={open} onOpenChange={(open) => !open && close()}>
      <Dialog.Portal container={container} keepMounted>
        <Dialog.Popup
          aria-label={title}
          data-comment-overlay
          className="absolute inset-0 z-20 flex min-h-0 flex-col overflow-hidden border border-border bg-surface shadow-lg outline-none data-[closed]:hidden"
          finalFocus={() => container.current?.querySelector<HTMLElement>('main[tabindex]') ?? false}
        >
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CommentOverlay({ container }: { container: RefObject<HTMLDivElement | null> }) {
  const list = useCommentOverlay((s) => s.list);
  const snapshot = useStore((s) => s.snapshot);
  const pr = snapshot?.review.kind === 'range' ? snapshot.review.pr : undefined;
  const [visited, setVisited] = useState<ReadonlySet<CommentList>>(() => new Set());
  // Keep each visited list mounted so reopening preserves its scroll and disclosure state.
  if (list && !visited.has(list)) setVisited(new Set([...visited, list]));

  const closeButton = (
    <Button variant="ghost" icon aria-label="Close comment overlay" title="Close (Esc)" onClick={close}>
      <X size="0.9375rem" />
    </Button>
  );
  return (
    <>
      {visited.has('threads') && (
        <CommentDialog list="threads" open={list === 'threads'} container={container}>
          <ThreadsPanel openTourThread={useTour.getState().revealThread} onJump={close} closeButton={closeButton} />
        </CommentDialog>
      )}
      {visited.has('github') && pr && (
        <CommentDialog list="github" open={list === 'github'} container={container}>
          <GithubCommentList pr={pr} onJump={close} closeButton={closeButton} />
        </CommentDialog>
      )}
    </>
  );
}

export function DiffWithComments() {
  const container = useRef<HTMLDivElement>(null);
  const reviewKey = useStore((s) => s.snapshot?.commentKey);
  return (
    <div ref={container} className="relative grid min-h-0 min-w-0 grid-cols-1 grid-rows-1">
      <ReviewPane />
      <CommentOverlay key={reviewKey} container={container} />
    </div>
  );
}
