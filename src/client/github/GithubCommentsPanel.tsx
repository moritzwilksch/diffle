import { GitPullRequest, RefreshCw } from 'lucide-react';
import { useId, useRef, useState, type ReactNode } from 'react';
import { CommentListControls } from '@/client/comments/overlay/CommentListControls.js';
import { ReplyButton } from '@/client/comments/reply/ReplyButton.js';
import { githubCommentsChanged } from './commentsEvent.js';
import { showGithubThread } from './inlineThreads.js';
import { GithubComment } from './GithubComment.js';
import { GithubThreadActions } from './GithubThreadActions.js';
import { useGithubComments } from './useGithubComments.js';
import { Button } from '@/client/ui/Button.js';
import type { GithubCommentThread, PullRef } from '@/shared/protocol.js';

const MIN_SHARE = 22;
const MAX_SHARE = 68;
const clamp = (percent: number) => Math.max(MIN_SHARE, Math.min(MAX_SHARE, Math.round(percent)));

export function GithubCommentsPanel({ pr, expandable }: { pr: PullRef; expandable?: boolean }) {
  const id = useId();
  const [share, setShare] = useState(42);
  return (
    <>
      <div
        role="separator"
        aria-label="Resize GitHub comments"
        aria-orientation="horizontal"
        aria-controls={id}
        aria-valuemin={100 - MAX_SHARE}
        aria-valuemax={100 - MIN_SHARE}
        aria-valuenow={100 - share}
        tabIndex={0}
        data-github-comments-resize
        className="group flex h-2 shrink-0 cursor-row-resize touch-none items-center justify-center border-t border-border focus-visible:outline-2 focus-visible:outline-accent"
        onPointerDown={(event) => {
          if (event.button === 0) event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const divider = event.currentTarget;
          if (!divider.hasPointerCapture(event.pointerId)) return;
          const box = divider.parentElement?.getBoundingClientRect();
          if (box?.height) setShare(clamp(((box.bottom - event.clientY) / box.height) * 100));
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
          event.preventDefault();
          setShare((value) => clamp(value + (event.key === 'ArrowUp' ? 5 : -5)));
        }}
      >
        <span className="h-0.5 w-7 rounded-full bg-border group-hover:bg-accent" />
      </div>
      <GithubCommentList id={id} share={share} pr={pr} expandable={expandable} />
    </>
  );
}

export function GithubCommentList({
  pr,
  id,
  share,
  expandable,
  onJump,
  closeButton,
}: {
  pr: PullRef;
  id?: string;
  share?: number;
  expandable?: boolean;
  onJump?: () => void;
  closeButton?: ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const { data, error, loading } = useGithubComments(pr.url);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const openThreads = data?.threads.filter((thread) => !collapsed.has(thread.id)) ?? [];
  const resolved = openThreads.filter((thread) => thread.isResolved);
  const outdated = openThreads.filter((thread) => thread.isOutdated);
  const count = data?.threads.length ?? 0;
  return (
    <section
      id={id}
      aria-label="GitHub comments"
      className={share === undefined ? 'flex min-h-0 flex-1 flex-col' : 'flex min-h-22 shrink-0 flex-col'}
      style={share === undefined ? undefined : { height: `${share}%` }}
    >
      <header className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-2.5 py-1">
        <GitPullRequest size="0.875rem" />
        <h3 className="mr-auto truncate font-semibold">GitHub comments</h3>
        {data && (
          <span className="text-xs text-muted">
            {count} {count === 1 ? 'thread' : 'threads'}
          </span>
        )}
        <CommentListControls list="github" scroller={scroller} expandable={expandable} />
        <Button
          variant="ghost"
          icon
          aria-label="Refresh GitHub comments"
          onClick={() => githubCommentsChanged(undefined)}
          disabled={loading}
        >
          <RefreshCw size="0.875rem" />
        </Button>
        {closeButton}
      </header>
      {!!count && (
        <div className="flex shrink-0 flex-wrap gap-1 border-b border-border px-2.5 py-1">
          <Button
            variant="ghost"
            disabled={!resolved.length}
            onClick={() => setCollapsed((current) => new Set([...current, ...resolved.map((thread) => thread.id)]))}
          >
            Collapse resolved
          </Button>
          <Button
            variant="ghost"
            disabled={!outdated.length}
            onClick={() => setCollapsed((current) => new Set([...current, ...outdated.map((thread) => thread.id)]))}
          >
            Collapse outdated
          </Button>
        </div>
      )}
      <div
        ref={scroller}
        role="region"
        aria-label="GitHub comments list"
        tabIndex={0}
        className="min-h-0 flex-1 space-y-2 overflow-auto px-2.5 py-2 text-xs"
      >
        {loading && !data && <p className="text-muted">Loading GitHub comments…</p>}
        {error && (
          <p role="alert" className="text-warn">
            {error}
          </p>
        )}
        {data && !count && !data.conversation.length && <p className="text-muted">No GitHub comments yet.</p>}
        {data?.conversation.length ? (
          <details open className="rounded-md border border-border bg-card">
            <summary className="cursor-pointer px-2 py-1.5 font-medium">General discussion</summary>
            <div className="divide-y divide-border border-t border-border">
              {data.conversation.map((message) => (
                <GithubComment key={message.id} message={message} prUrl={pr.url} />
              ))}
            </div>
          </details>
        ) : null}
        {data?.threads.map((thread) => (
          <GithubThreadRow
            key={thread.id}
            prUrl={pr.url}
            thread={thread}
            open={!collapsed.has(thread.id)}
            onOpenChange={(open) =>
              setCollapsed((current) => {
                if (open === !current.has(thread.id)) return current;
                const next = new Set(current);
                if (open) next.delete(thread.id);
                else next.add(thread.id);
                return next;
              })
            }
            onJump={onJump}
          />
        ))}
      </div>
    </section>
  );
}

function GithubThreadRow({
  prUrl,
  thread,
  open,
  onOpenChange,
  onJump,
}: {
  prUrl: string;
  thread: GithubCommentThread;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onJump?: () => void;
}) {
  const [composing, setComposing] = useState(false);
  const end = thread.line ?? thread.originalLine;
  const start = thread.line == null ? thread.originalStartLine : thread.startLine;
  const range = end == null ? '' : start != null && start !== end ? `:${start}–${end}` : `:${end}`;
  const jump = thread.isOutdated
    ? undefined
    : () => {
        if (showGithubThread(prUrl, thread)) onJump?.();
      };
  return (
    <details
      open={open}
      className="rounded-md border border-border bg-card"
      onToggle={(event) => onOpenChange(event.currentTarget.open)}
    >
      <summary className={`relative cursor-pointer px-2 py-1.5 ${thread.viewerCanReply ? 'pr-9' : ''}`}>
        <span className="font-mono break-all">
          {thread.path}
          {range}
        </span>
        {thread.diffSide === 'LEFT' && range && <span className="ml-2 text-muted">Old side</span>}
        {thread.isResolved && <span className="ml-2 text-add">Resolved</span>}
        {thread.isOutdated && <span className="ml-2 text-warn">Outdated</span>}
        {thread.viewerCanReply && (!open || !composing) && (
          <ReplyButton
            className="absolute top-1 right-1 hover:bg-surface"
            onClick={() => {
              onOpenChange(true);
              setComposing(true);
            }}
          />
        )}
      </summary>
      <div className="divide-y divide-border border-t border-border">
        {thread.comments.map((message) => (
          <GithubComment key={message.id} message={message} prUrl={prUrl} onOpen={jump} />
        ))}
        {thread.comments.length === 0 && (
          <a className="block p-2 text-accent" href={prUrl} target="_blank" rel="noreferrer">
            Open pull request
          </a>
        )}
      </div>
      <GithubThreadActions
        prUrl={prUrl}
        thread={thread}
        composing={open && composing}
        setComposing={setComposing}
        replyInHeader
      />
    </details>
  );
}
