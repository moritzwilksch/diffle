import { CopyIcon } from '../ui/CopyIcon.js';
import { twMerge } from 'tailwind-merge';
import { Button } from '../ui/Button.js';
import {
  AlertTriangle,
  Check,
  Copy,
  GitPullRequestArrow,
  MessageSquare,
  Pencil,
  Reply,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { CommentMessage, CommentThread } from '../../shared/protocol.js';
import { api } from '../api.js';
import { copyText } from '../clipboard.js';
import { Markdown } from '../Markdown.js';
import { canExportToGithub, exportLabel, type ExportOutcome } from '../model.js';
import { useStore } from '../store.js';
import { useConfirm } from '../useConfirm.js';

/** A thread rendered inline under its last anchored line: messages, reply composer, resolve. */
export function CommentCard({ thread }: { thread: CommentThread }) {
  const deleteThread = useStore((s) => s.deleteThread);
  const setResolved = useStore((s) => s.setResolved);
  const replying = useStore((s) => s.replyTo === thread.id);
  const openReply = useStore((s) => s.openReply);
  const closeReply = useStore((s) => s.closeReply);
  const editingId = useStore((s) => s.editingId);
  const setEditingId = useStore((s) => s.setEditingId);
  const focused = useStore((s) => s.focusedThread === thread.id);
  const exportToGithub = useStore((s) => s.exportToGithub);
  const canExport = useStore((s) => canExportToGithub(s.snapshot));
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
  // A lone message has no `who` row of its own, so its edit control sits with the thread actions.
  const solo = thread.messages.length === 1 ? thread.messages[0]! : null;
  const editingSolo = solo != null && editingId === solo.id;

  const a = thread.anchor;
  const range = a.startLine === a.endLine ? `${a.startLine}` : `${a.startLine}–${a.endLine}`;

  return (
    <div
      className={twMerge(
        `mx-2 my-1 overflow-hidden rounded-md border border-border bg-card p-0 font-sans text-[0.8125rem] shadow-card [&_.markdown]:[word-break:break-word] ${thread.stale ? 'border-dashed' : ''} ${thread.resolved ? 'opacity-70' : ''} ${focused ? 'border-accent shadow-[0_0_0_1px_var(--accent),_var(--review-card-shadow)]' : ''}`,
      )}
    >
      <div className="flex items-center gap-2 border-b border-b-border bg-hover py-1 pr-1.5 pl-2.5 text-[0.75rem] text-muted [&>svg]:flex-none [&>svg]:text-accent">
        <MessageSquare size="0.8125rem" />
        <span className="font-mono font-semibold text-foreground">
          {a.side === 'old' ? 'removed ' : ''}L{range}
        </span>
        {thread.stale && (
          <span
            className="inline-flex items-center gap-0.75 text-warn"
            title="Not found in the current diff: the text changed or left the changed lines"
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
        {solo && <CopyMessageButton threadId={thread.id} messageId={solo.id} size="0.875rem" />}
        {solo && (
          <Button
            variant="ghost"
            icon
            onClick={() => setEditingId(editingSolo ? null : solo.id)}
            title={editingSolo ? 'Cancel' : 'Edit (e)'}
          >
            {editingSolo ? <X size="0.875rem" /> : <Pencil size="0.875rem" />}
          </Button>
        )}
        {canExport && (
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
                  : 'Add this thread to a pending review on the GitHub pull request; you submit it on GitHub'
            }
          >
            {posted ? <Check size="0.875rem" /> : <GitPullRequestArrow size="0.875rem" />}
            {post.armed ? 'Add?' : posted ? exportLabel(posted) : null}
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
          {del.armed && 'Delete?'}
        </Button>
      </div>
      {thread.messages.map((m, i) => (
        <Message key={m.id} thread={thread} message={m} first={i === 0} />
      ))}
      {replying && <ReplyComposer threadId={thread.id} />}
    </div>
  );
}

function Message({ thread, message, first }: { thread: CommentThread; message: CommentMessage; first: boolean }) {
  const editMessage = useStore((s) => s.editMessage);
  const deleteMessage = useStore((s) => s.deleteMessage);
  const editing = useStore((s) => s.editingId === message.id);
  const setEditingId = useStore((s) => s.setEditingId);
  const [text, setText] = useState(message.body);
  const del = useConfirm(() => void deleteMessage(thread.id, message.id));
  useEffect(() => {
    if (editing) setText(message.body);
  }, [editing, message.body]);
  const threaded = thread.messages.length > 1;
  const save = () => {
    void editMessage(thread.id, message.id, text);
    setEditingId(null);
  };
  return (
    <div className="px-2.5 py-2 data-[first=false]:border-t data-[first=false]:border-border" data-first={first}>
      {threaded && (
        <div className="mb-[2px] flex items-center gap-1.5 text-[0.6875rem] text-muted">
          <span className="flex-1" />
          <CopyMessageButton threadId={thread.id} messageId={message.id} size="0.75rem" />
          <Button
            variant="ghost"
            icon
            onClick={() => setEditingId(editing ? null : message.id)}
            title={editing ? 'Cancel' : 'Edit (e)'}
          >
            {editing ? <X size="0.75rem" /> : <Pencil size="0.75rem" />}
          </Button>
          {!first && (
            <Button
              variant="ghost"
              danger
              icon={!del.armed}
              feedback={del.armed ? 'confirm' : undefined}
              onClick={del.fire}
              title={del.armed ? 'Click again to delete this reply' : 'Delete this reply'}
            >
              <Trash2 size="0.75rem" />
              {del.armed && 'Delete?'}
            </Button>
          )}
        </div>
      )}
      {editing ? (
        <div className="rounded-md border-0 bg-surface p-0">
          <textarea
            className="min-h-17.5 w-full resize-y rounded-sm border border-border bg-canvas p-1.5 font-mono text-[0.75rem] leading-[1.5]"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditingId(null);
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
            }}
            autoFocus
          />
          <div className="mt-1.5 flex items-center justify-end gap-1.5">
            <Button variant="primary" onClick={save}>
              Save
            </Button>
          </div>
        </div>
      ) : (
        <Markdown text={message.body} path={thread.anchor.path} />
      )}
    </div>
  );
}

/** Copies one message in agent-prompt format; the icon morphs into a check mark after success. */
function CopyMessageButton({ threadId, messageId, size }: { threadId: string; messageId: string; size: string }) {
  const flash = useStore((s) => s.flash);
  const report = useStore((s) => s.report);
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return (
    <Button
      variant="ghost"
      icon
      feedback={done ? 'copied' : undefined}
      className="relative [transition:background_160ms_ease,_color_160ms_ease,_border-color_160ms_ease]"
      title="Copy this comment as a prompt"
      onClick={async () => {
        let text: string;
        try {
          text = await api.exportComment(threadId, messageId);
        } catch (e) {
          report('Copying comment', e);
          return;
        }
        if (!(await copyText(text))) return flash('The browser blocked clipboard access');
        setDone(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setDone(false), 1400);
      }}
    >
      <CopyIcon done={done} size={size}>
        <Copy size={size} />
      </CopyIcon>
    </Button>
  );
}

function ReplyComposer({ threadId }: { threadId: string }) {
  const submitReply = useStore((s) => s.submitReply);
  const closeReply = useStore((s) => s.closeReply);
  const [text, setText] = useState('');
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
    <div className="mx-2.5 mt-0 mb-2.5 rounded-md border border-accent bg-surface p-2">
      <textarea
        className="min-h-17.5 w-full resize-y rounded-sm border border-border bg-canvas p-1.5 font-mono text-[0.75rem] leading-[1.5]"
        ref={ref}
        value={text}
        placeholder="Reply…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') closeReply();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
        }}
      />
      <div className="mt-1.5 flex items-center justify-end gap-1.5">
        <span className="mr-auto text-[0.75rem] text-muted">
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
