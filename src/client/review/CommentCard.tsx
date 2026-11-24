import { twMerge } from 'tailwind-merge';
import { Button } from '@/client/ui/Button.js';
import { AlertTriangle, Check, GitPullRequestArrow, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { CommentThread } from '@/shared/protocol.js';
import { ThreadIcon } from '@/client/comments/AgentMark.js';
import { ThreadMessage } from '@/client/comments/ThreadMessage.js';
import { editableThreadMessage } from '@/client/comments/threads.js';
import { anchorLabel, exportLabel, type ExportOutcome } from '@/client/model.js';
import { collapseFromCardClick, InlineThreadCollapse } from '@/client/comments/InlineThreadCollapse.js';
import { ReplyButton } from '@/client/comments/reply/ReplyButton.js';
import { ReplyComposer } from '@/client/comments/reply/ReplyComposer.js';
import { useStore } from '@/client/store.js';
import { ButtonLabel } from '@/client/ui/ButtonLabel.js';
import { useConfirm } from '@/client/useConfirm.js';

/**
 * A thread rendered inline under its last anchored line, or beside the tour: messages, reply
 * composer, resolve. `className` adjusts its outer spacing to where it sits.
 */
export function CommentCard({
  thread,
  className,
  onCollapse,
}: {
  thread: CommentThread;
  className?: string;
  onCollapse?: () => void;
}) {
  const deleteThread = useStore((s) => s.deleteThread);
  const setResolved = useStore((s) => s.setResolved);
  const replying = useStore((s) => s.replyTo?.threadId === thread.id && !s.replyTo.panelId);
  const openReply = useStore((s) => s.openReply);
  const closeReply = useStore((s) => s.closeReply);
  const focused = useStore((s) => s.focusedThread === thread.id);
  const exportToGithub = useStore((s) => s.exportToGithub);
  const canExport = useStore((s) => s.github.data?.reason === null);
  const [posting, setPosting] = useState(false);
  const [posted, setPosted] = useState<ExportOutcome | null>(null);
  const del = useConfirm(() => void deleteThread(thread.id));
  const post = useConfirm(() => {
    setPosting(true);
    void exportToGithub([thread.id])
      .then(setPosted)
      .finally(() => setPosting(false));
  });
  useEffect(() => {
    if (!posted) return;
    const t = setTimeout(() => setPosted(null), 2000);
    return () => clearTimeout(t);
  }, [posted]);
  const a = thread.anchor;
  const editable = editableThreadMessage(thread);

  return (
    <div
      role={onCollapse ? 'presentation' : undefined}
      onClick={onCollapse && ((event) => collapseFromCardClick(event, onCollapse))}
      className={twMerge(
        `mx-2 my-1 overflow-hidden rounded-md border border-border bg-card p-0 font-sans text-[0.8125rem] shadow-card [&_.markdown]:[word-break:break-word] ${thread.stale ? 'border-dashed' : ''} ${thread.resolved ? 'opacity-70' : ''} ${focused ? 'border-accent shadow-[0_0_0_1px_var(--accent),_var(--review-card-shadow)]' : ''}`,
        onCollapse && 'cursor-pointer',
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-b-border bg-hover py-1 pr-1.5 pl-2.5 text-[0.75rem] text-muted [&>svg]:flex-none [&>svg]:text-accent">
        <ThreadIcon thread={thread} />
        {/* Lines are code; a tour's words are prose, cut to one line in the narrow margin. */}
        <span
          className={`font-semibold text-foreground ${a.kind === 'tour' ? 'min-w-0 truncate font-sans' : 'font-mono'}`}
        >
          {anchorLabel(a)}
        </span>
        {thread.stale && (
          <span
            className="inline-flex items-center gap-0.75 text-warn"
            title={
              a.kind === 'tour'
                ? "Not in the tour: the agent's last push no longer holds it"
                : a.kind === 'file'
                  ? 'Not in the current diff: the file left the review'
                  : 'Not found in the current diff: the text changed or left the changed lines'
            }
          >
            <AlertTriangle size="0.75rem" /> stale
          </span>
        )}
        {thread.resolved && (
          <span className="inline-flex items-center gap-0.75 text-add">
            <Check size="0.75rem" /> resolved
          </span>
        )}
        <span className="flex-1" />
        {canExport && thread.anchor.kind !== 'tour' && (
          <Button
            variant="ghost"
            icon={!post.armed && !posted}
            feedback={post.armed ? 'confirm' : posted ? 'posted' : undefined}
            disabled={posting || thread.stale}
            onClick={post.fire}
            title={
              thread.stale
                ? 'Stale threads cannot be added to a GitHub review'
                : post.armed
                  ? 'Click again to add this thread to the pending review'
                  : 'Add this thread to a pending review on the GitHub pull request'
            }
          >
            {posted ? <Check size="0.875rem" /> : <GitPullRequestArrow size="0.875rem" />}
            <ButtonLabel text={post.armed ? 'Add?' : posted && exportLabel(posted)} />
          </Button>
        )}
        <ReplyButton replying={replying} onClick={() => (replying ? closeReply() : openReply(thread.id))} />
        <Button
          variant="ghost"
          icon
          onClick={() => void setResolved(thread.id, !thread.resolved)}
          title={thread.resolved ? 'Reopen (R)' : 'Resolve (R)'}
        >
          {thread.resolved ? <RotateCcw size="0.875rem" /> : <Check size="0.875rem" />}
        </Button>
        <Button
          variant="ghost"
          danger
          icon={!del.armed}
          feedback={del.armed ? 'confirm' : undefined}
          onClick={del.fire}
          title={del.armed ? 'Click again to delete this thread' : 'Delete thread (dd)'}
        >
          <Trash2 size="0.875rem" />
          <ButtonLabel text={del.armed && 'Delete?'} />
        </Button>
        {onCollapse && <InlineThreadCollapse label="Collapse local thread" onCollapse={onCollapse} />}
      </div>
      {thread.messages.map((m, i) => (
        <ThreadMessage key={m.id} thread={thread} message={m} first={i === 0} editable={m === editable} />
      ))}
      {replying && <ReplyComposer threadId={thread.id} />}
    </div>
  );
}
