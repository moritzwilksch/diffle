import { TextArea } from '@/client/ui/TextArea.js';
import { twMerge } from 'tailwind-merge';
import { Button } from '@/client/ui/Button.js';
import { AlertTriangle, Check, GitPullRequestArrow, Reply, RotateCcw, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { CommentThread } from '@/shared/protocol.js';
import { ThreadIcon } from '@/client/comments/AgentMark.js';
import { ThreadMessage } from '@/client/comments/ThreadMessage.js';
import { editableThreadMessage } from '@/client/comments/threads.js';
import { anchorLabel, composerKey, exportLabel, type ExportOutcome } from '@/client/model.js';
import { collapseFromCardClick, InlineThreadCollapse } from '@/client/comments/InlineThreadCollapse.js';
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
  const replying = useStore((s) => s.replyTo === thread.id);
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
        <Button
          variant="ghost"
          icon
          onClick={() => (replying ? closeReply() : openReply(thread.id))}
          title={replying ? 'Cancel reply' : 'Reply'}
        >
          {replying ? <X size="0.875rem" /> : <Reply size="0.875rem" />}
        </Button>
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

function ReplyComposer({ threadId }: { threadId: string }) {
  const submitReply = useStore((s) => s.submitReply);
  const closeReply = useStore((s) => s.closeReply);
  const key = useStore((s) => composerKey(s, { kind: 'reply', threadId }));
  const text = useStore((s) => (key ? (s.unsent[key] ?? '') : ''));
  const setUnsent = useStore((s) => s.setUnsent);
  const setText = (t: string) => key && setUnsent(key, t);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await submitReply(threadId, text);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="@container mx-2.5 mt-0 mb-2.5 rounded-md border border-accent bg-surface p-2">
      <TextArea
        className="min-h-17.5 w-full resize-y rounded-sm border border-border bg-canvas p-1.5 font-mono text-[0.75rem] leading-[1.5]"
        ref={ref}
        value={text}
        placeholder="Reply…"
        onValueChange={setText}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
        }}
      />
      <div className="mt-1.5 flex flex-wrap items-center justify-end gap-1.5">
        <span className="mr-auto text-[0.75rem] whitespace-nowrap text-muted @max-[26rem]:hidden">
          <kbd>⌘/Ctrl</kbd>+<kbd>Enter</kbd> to send · <kbd>Esc</kbd> to cancel
        </span>
        <Button onClick={closeReply}>Cancel</Button>
        <Button variant="primary" onClick={() => void submit()} disabled={!text.trim() || busy}>
          Reply
        </Button>
      </div>
    </div>
  );
}
