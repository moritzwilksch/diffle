import { AlertTriangle, Check, Copy, GitPullRequestArrow, MessageSquare, Pencil, Reply, RotateCcw, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { CommentMessage, CommentThread } from '../../shared/protocol.js';
import { copyText } from '../clipboard.js';
import { Markdown } from '../Markdown.js';
import { exportLabel, type ExportOutcome } from '../model.js';
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
    <div className={`annotation comment-card ${thread.stale ? 'stale' : ''} ${thread.resolved ? 'resolved' : ''} ${focused ? 'focused' : ''}`}>
      <div className="meta">
        <MessageSquare size="0.8125rem" />
        <span className="loc">
          {a.side === 'old' ? 'removed ' : ''}L{range}
        </span>
        {thread.stale && (
          <span className="stale-tag" title="Not found in the current diff: the text changed or left the changed lines">
            <AlertTriangle size="0.75rem" /> stale
          </span>
        )}
        {thread.resolved && (
          <span className="resolved-tag">
            <Check size="0.75rem" /> resolved
          </span>
        )}
        <span className="spacer" />
        {solo && <CopyMessageButton text={solo.body} size="0.875rem" />}
        {solo && (
          <button className="ghost icon" onClick={() => setEditingId(editingSolo ? null : solo.id)} title={editingSolo ? 'Cancel' : 'Edit (e)'}>
            {editingSolo ? <X size="0.875rem" /> : <Pencil size="0.875rem" />}
          </button>
        )}
        <button
          className={`ghost ${post.armed ? 'confirm' : posted ? 'posted' : 'icon'}`}
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
        </button>
        <button className="ghost icon" onClick={() => (replying ? closeReply() : openReply(thread.id))} title={replying ? 'Cancel reply' : 'Reply'}>
          {replying ? <X size="0.875rem" /> : <Reply size="0.875rem" />}
        </button>
        <button
          className="ghost icon"
          onClick={() => void setResolved(thread.id, !thread.resolved)}
          title={thread.resolved ? 'Reopen (R)' : 'Resolve (R)'}
        >
          {thread.resolved ? <RotateCcw size="0.875rem" /> : <Check size="0.875rem" />}
        </button>
        <button className={`ghost danger ${del.armed ? 'confirm' : 'icon'}`} onClick={del.fire} title={del.armed ? 'Click again to delete this thread' : 'Delete thread (dd)'}>
          <Trash2 size="0.875rem" />
          {del.armed && 'Delete?'}
        </button>
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
    <div className="message">
      {threaded && (
        <div className="who">
          <span className="spacer" />
          <CopyMessageButton text={message.body} size="0.75rem" />
          <button className="ghost icon" onClick={() => setEditingId(editing ? null : message.id)} title={editing ? 'Cancel' : 'Edit (e)'}>
            {editing ? <X size="0.75rem" /> : <Pencil size="0.75rem" />}
          </button>
          {!first && (
            <button className={`ghost danger ${del.armed ? 'confirm' : 'icon'}`} onClick={del.fire} title={del.armed ? 'Click again to delete this reply' : 'Delete this reply'}>
              <Trash2 size="0.75rem" />
              {del.armed && 'Delete?'}
            </button>
          )}
        </div>
      )}
      {editing ? (
        <div className="composer" style={{ border: 0, padding: 0 }}>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditingId(null);
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
            }}
            autoFocus
          />
          <div className="row">
            <button className="primary" onClick={save}>
              Save
            </button>
          </div>
        </div>
      ) : (
        <Markdown text={message.body} path={thread.anchor.path} />
      )}
    </div>
  );
}

/** Copies one message's markdown body; the icon morphs into a check mark after a successful copy. */
function CopyMessageButton({ text, size }: { text: string; size: string }) {
  const flash = useStore((s) => s.flash);
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return (
    <button
      className={`ghost icon copy-btn ${done ? 'done' : ''}`}
      title="Copy this comment"
      onClick={async () => {
        if (!(await copyText(text))) return flash('The browser blocked clipboard access');
        setDone(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setDone(false), 1400);
      }}
    >
      <span className="copy-icon">
        <span className="i">
          <Copy size={size} />
        </span>
        <span className="ok">
          <Check size={size} />
        </span>
      </span>
    </button>
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
    <div className="composer reply">
      <textarea
        ref={ref}
        value={text}
        placeholder="Reply…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') closeReply();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
        }}
      />
      <div className="row">
        <span className="hint">
          <kbd>⌘/Ctrl</kbd>+<kbd>Enter</kbd> to send · <kbd>Esc</kbd> to cancel
        </span>
        <button onClick={closeReply}>Cancel</button>
        <button className="primary" onClick={() => void submit()} disabled={!text.trim() || busy}>
          Reply
        </button>
      </div>
    </div>
  );
}
