import { CornerDownLeft, ExternalLink, GitPullRequest, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';
import { api } from '@/client/api.js';
import { githubCommentsEvent } from './commentsEvent.js';
import { refreshGithubPeek, showGithubComment } from './commentPeek.js';
import { githubCommentBody } from './GithubPeekCard.js';
import { GithubPendingDelete } from './GithubPendingDelete.js';
import { Markdown } from '@/client/Markdown.js';
import { Button } from '@/client/ui/Button.js';
import type { GithubCommentMessage, GithubComments, PullRef } from '@/shared/protocol.js';

const MIN_SHARE = 22;
const MAX_SHARE = 68;
const clamp = (percent: number) => Math.max(MIN_SHARE, Math.min(MAX_SHARE, Math.round(percent)));

export function GithubCommentsPanel({ pr }: { pr: PullRef }) {
  const id = useId();
  const [share, setShare] = useState(42);
  const [data, setData] = useState<GithubComments>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [revision, refresh] = useState(0);
  const reload = useCallback(() => refresh((value) => value + 1), []);

  useEffect(() => {
    window.addEventListener(githubCommentsEvent, reload);
    return () => window.removeEventListener(githubCommentsEvent, reload);
  }, [reload]);

  useEffect(() => {
    const controller = new AbortController();
    setError(undefined);
    setLoading(true);
    void api.githubComments(controller.signal).then(
      (comments) => {
        if (controller.signal.aborted) return;
        setData(comments);
        refreshGithubPeek(pr.url, comments);
        setLoading(false);
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoading(false);
      },
    );
    return () => controller.abort();
  }, [pr.url, revision]);

  const count = data?.threads.length ?? 0;
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
      <section
        id={id}
        aria-label="GitHub comments"
        className="flex min-h-22 shrink-0 flex-col"
        style={{ height: `${share}%` }}
      >
        <header className="flex shrink-0 items-center gap-1.5 border-b border-border px-2.5 py-1">
          <GitPullRequest size="0.875rem" />
          <h3 className="mr-auto truncate font-semibold">GitHub comments</h3>
          {data && (
            <span className="text-xs text-muted">
              {count} {count === 1 ? 'thread' : 'threads'}
            </span>
          )}
          <Button variant="ghost" icon aria-label="Refresh GitHub comments" onClick={reload} disabled={loading}>
            <RefreshCw size="0.875rem" />
          </Button>
        </header>
        <div className="min-h-0 flex-1 space-y-2 overflow-auto px-2.5 py-2 text-xs">
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
                  <Comment key={message.id} message={message} prUrl={pr.url} />
                ))}
              </div>
            </details>
          ) : null}
          {data?.threads.map((thread) => {
            const end = thread.line ?? thread.originalLine;
            const start = thread.line == null ? thread.originalStartLine : thread.startLine;
            const range = end == null ? '' : start != null && start !== end ? `:${start}–${end}` : `:${end}`;
            return (
              <details key={thread.id} open className="rounded-md border border-border bg-card">
                <summary className="cursor-pointer px-2 py-1.5">
                  <span className="font-mono break-all">
                    {thread.path}
                    {range}
                  </span>
                  {thread.diffSide === 'LEFT' && range && <span className="ml-2 text-muted">Old side</span>}
                  {thread.isResolved && <span className="ml-2 text-add">Resolved</span>}
                  {thread.isOutdated && <span className="ml-2 text-warn">Outdated</span>}
                </summary>
                <div className="divide-y divide-border border-t border-border">
                  {thread.comments.map((message) => (
                    <Comment
                      key={message.id}
                      message={message}
                      prUrl={pr.url}
                      onOpen={() => showGithubComment(pr.url, thread, message)}
                    />
                  ))}
                  {thread.comments.length === 0 && (
                    <a className="block p-2 text-accent" href={pr.url} target="_blank" rel="noreferrer">
                      Open pull request
                    </a>
                  )}
                </div>
              </details>
            );
          })}
        </div>
      </section>
    </>
  );
}

const states: Record<string, string> = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  CHANGES_REQUESTED: 'Changes requested',
  DISMISSED: 'Dismissed',
};

function Comment({ message, prUrl, onOpen }: { message: GithubCommentMessage; prUrl: string; onOpen?: () => void }) {
  const state = message.state && states[message.state];
  const href = /^https?:\/\//i.test(message.url) ? message.url : undefined;
  const body = githubCommentBody(message.body);
  return (
    <article className="px-2 py-1.5 wrap-anywhere">
      <div className="mb-1 flex items-baseline gap-1.5">
        {onOpen ? (
          <button
            type="button"
            className="inline-flex cursor-pointer items-center gap-1 font-semibold hover:text-accent hover:underline"
            title="Show comment in code"
            onClick={onOpen}
          >
            {message.author} <CornerDownLeft size="0.6875rem" />
          </button>
        ) : (
          <strong>{message.author}</strong>
        )}
        {state && <span className="text-muted">{state}</span>}
        {href && (
          <a
            aria-label="Open comment on GitHub"
            className="ml-auto text-accent"
            href={href}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size="0.75rem" />
          </a>
        )}
        <GithubPendingDelete prUrl={prUrl} message={message} />
      </div>
      {onOpen ? (
        <div
          role="presentation"
          className="cursor-pointer"
          onClick={(event) => {
            if (event.target instanceof Element && event.target.closest('a, button')) return;
            if (window.getSelection()?.isCollapsed !== false) onOpen();
          }}
        >
          <Markdown text={body} />
        </div>
      ) : (
        <Markdown text={body} />
      )}
    </article>
  );
}
