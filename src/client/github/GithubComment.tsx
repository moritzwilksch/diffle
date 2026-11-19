import { CornerDownLeft, ExternalLink } from 'lucide-react';
import { Markdown } from '@/client/Markdown.js';
import { CommentDate } from '@/client/comments/CommentDate.js';
import type { GithubCommentMessage } from '@/shared/protocol.js';
import { GithubPendingDelete } from './GithubPendingDelete.js';
import { GithubPendingEdit } from './GithubPendingEdit.js';

const states: Record<string, string> = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  CHANGES_REQUESTED: 'Changes requested',
  DISMISSED: 'Dismissed',
};

export function GithubComment({
  message,
  prUrl,
  path,
  onOpen,
  allowChanges = true,
}: {
  message: GithubCommentMessage;
  prUrl: string;
  path?: string;
  onOpen?: () => void;
  allowChanges?: boolean;
}) {
  const state = message.state && states[message.state];
  const href = /^https?:\/\//i.test(message.url) ? message.url : undefined;
  const body = message.body.replace(/\n*<!-- diffle-thread:[^>]* -->\s*$/, '');
  return (
    <article className="px-2 py-1.5 wrap-anywhere">
      <div className="mb-1 flex flex-wrap items-baseline gap-1.5">
        {onOpen ? (
          <button
            type="button"
            className="inline-flex cursor-pointer items-center gap-1 font-semibold hover:text-accent hover:underline"
            title="Show thread in code"
            onClick={onOpen}
          >
            {message.author} <CornerDownLeft size="0.6875rem" />
          </button>
        ) : (
          <strong>{message.author}</strong>
        )}
        <CommentDate createdAt={message.createdAt} />
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
        {allowChanges && message.canEdit && <GithubPendingEdit prUrl={prUrl} id={message.id} body={body} />}
        {allowChanges && <GithubPendingDelete prUrl={prUrl} message={message} />}
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
          <Markdown text={body} path={path} />
        </div>
      ) : (
        <Markdown text={body} path={path} />
      )}
    </article>
  );
}
