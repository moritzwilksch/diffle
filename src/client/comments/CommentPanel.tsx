import { AlertTriangle, Check, ClipboardCopy, GitPullRequestArrow, MessageSquare, Trash2 } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { CommentThread, Side } from '../../shared/protocol.js';
import { api } from '../api.js';
import { copyText } from '../clipboard.js';
import { exportLabel, type ExportOutcome, visibleThreads } from '../model.js';
import { useStore } from '../store.js';
import { FilePath } from '../FilePath.js';
import { Markdown } from '../Markdown.js';
import { useConfirm } from '../useConfirm.js';

export function CommentPanel() {
  const threads = useStore((s) => s.threads);
  const showResolved = useStore((s) => s.showResolved);
  const setShowResolved = useStore((s) => s.setShowResolved);
  const openFile = useStore((s) => s.openFile);
  const clearThreads = useStore((s) => s.clearThreads);
  const deleteThread = useStore((s) => s.deleteThread);
  const deleteStaleThreads = useStore((s) => s.deleteStaleThreads);
  const focusThread = useStore((s) => s.focusThread);
  const report = useStore((s) => s.report);
  const exportToGithub = useStore((s) => s.exportToGithub);
  const [posting, setPosting] = useState(false);
  const [manual, setManual] = useState<string | null>(null);
  const [posted, setPosted] = useState<ExportOutcome | null>(null);
  useEffect(() => {
    if (!posted) return;
    const t = setTimeout(() => setPosted(null), 2000);
    return () => clearTimeout(t);
  }, [posted]);
  const post = useConfirm(() => {
    setPosting(true);
    void exportToGithub()
      .then(setPosted)
      .finally(() => setPosting(false));
  });
  const clear = useConfirm(() => void clearThreads());
  const stale = useConfirm(() => void deleteStaleThreads());

  const shown = useMemo(() => visibleThreads({ threads, showResolved }), [threads, showResolved]);
  const open = threads.filter((t) => !t.resolved);
  const resolvedCount = threads.length - open.length;
  const staleCount = threads.filter((t) => t.stale).length;
  const groups = useMemo(() => {
    const by = new Map<string, CommentThread[]>();
    for (const t of [...shown].sort(cmp)) {
      const list = by.get(t.anchor.path) ?? [];
      list.push(t);
      by.set(t.anchor.path, list);
    }
    return [...by.entries()];
  }, [shown]);

  const copy = async (): Promise<boolean> => {
    let text: string;
    try {
      text = await api.exportComments();
    } catch (e) {
      // Otherwise the button stays quiet and the previous clipboard gets pasted into the agent.
      report('Copying comments', e);
      return false;
    }
    if (await copyText(text)) return true;
    setManual(text);
    return false;
  };

  return (
    <aside className="panel">
      <div className="panel-head">
        <span className="title">
          <MessageSquare size="0.9375rem" /> Threads
          {open.length > 0 && <span className="count">{open.length}</span>}
        </span>
        <CopyButton
          label="All"
          icon={<ClipboardCopy size="0.875rem" />}
          primary
          disabled={open.length === 0}
          title="Copy all open threads as a prompt (yy)"
          onCopy={() => copy()}
        />
        <button
          className={`ghost ${post.armed ? 'confirm' : posted ? 'posted' : 'icon'}`}
          disabled={posting || (open.length === 0 && !posted)}
          title={
            post.armed
              ? 'Click again to add all open threads to the pending review'
              : 'Add all open threads to a pending review on the GitHub pull request; you submit it on GitHub'
          }
          aria-label={
            post.armed
              ? 'Add all open threads to the pending review? Click again to confirm'
              : 'Add all open threads to a pending review on the GitHub pull request'
          }
          onClick={post.fire}
        >
          {posted ? <Check size="0.875rem" /> : <GitPullRequestArrow size="0.875rem" />}
          {post.armed ? 'Add all?' : posted ? exportLabel(posted) : null}
        </button>
        <button
          className={`ghost danger ${clear.armed ? 'confirm' : 'icon'}`}
          disabled={threads.length === 0}
          title={clear.armed ? 'Click again to delete all threads' : 'Delete all threads for this mode'}
          onClick={clear.fire}
        >
          <Trash2 size="0.875rem" />
          {clear.armed && 'Delete all?'}
        </button>
      </div>
      {staleCount > 0 && (
        <div
          className="panel-filter stale-row"
          title="Stale threads no longer point into the diff: their text changed or left the changed lines"
        >
          <AlertTriangle size="0.75rem" />
          {staleCount} stale
          <button className={`ghost danger ${stale.armed ? 'confirm' : ''}`} onClick={stale.fire}>
            <Trash2 size="0.75rem" />
            {stale.armed ? 'Delete stale?' : 'Delete'}
          </button>
        </div>
      )}
      {resolvedCount > 0 && (
        <label className="panel-filter" title="Resolved threads are kept but left out of the prompt">
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
          Show {resolvedCount} resolved
        </label>
      )}
      <div className="list">
        {groups.length === 0 && (
          <div className="empty">
            <p>{threads.length ? 'Every thread is resolved.' : 'No comments yet.'}</p>
            <p>Click a line number to comment, or drag across line numbers for a block.</p>
          </div>
        )}
        {groups.map(([path, list]) => (
          <section className="group" key={path}>
            <h4>
              <FilePath path={path} />
            </h4>
            {list.map((t) => (
              <ThreadRow
                key={t.id}
                thread={t}
                openFile={openFile}
                focusThread={focusThread}
                deleteThread={deleteThread}
              />
            ))}
          </section>
        ))}
      </div>
      {manual && (
        <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setManual(null)}>
          <div className="dialog" role="dialog" aria-label="Copy manually">
            <h3>Copy manually</h3>
            <p>The browser blocked clipboard access. Select the text below and press Ctrl/⌘+c.</p>
            <textarea readOnly value={manual} autoFocus onFocus={(e) => e.currentTarget.select()} />
            <div className="row">
              <button onClick={() => setManual(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

/**
 * One thread. Memoized on the thread object and the store's stable actions, so
 * header-only changes (the active file, confirm timers) leave Markdown bodies alone.
 */
const ThreadRow = memo(function ThreadRow({
  thread: t,
  openFile,
  focusThread,
  deleteThread,
}: {
  thread: CommentThread;
  openFile: (path: string, line: number, side: Side) => Promise<void>;
  focusThread: (id: string | null) => void;
  deleteThread: (id: string) => Promise<void>;
}) {
  const first = t.messages[0];
  const del = useConfirm(() => void deleteThread(t.id));
  const open = () => {
    void openFile(t.anchor.path, t.anchor.endLine, t.anchor.side);
    // Set after the jump: moving the cursor or selecting lines clears the ring again.
    focusThread(t.id);
  };
  return (
    // A div, not a button: the item hosts its own delete button.
    <div
      role="button"
      tabIndex={0}
      className={`item ${t.stale ? 'is-stale' : ''} ${t.resolved ? 'is-resolved' : ''}`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
    >
      <div className="loc">
        <MessageSquare size="0.8125rem" />
        <span className="lines">
          {t.anchor.side === 'old' ? 'removed ' : ''}L{t.anchor.startLine}
          {t.anchor.endLine !== t.anchor.startLine ? `–${t.anchor.endLine}` : ''}
        </span>
        {t.messages.length > 1 && (
          <span className="replies">
            {t.messages.length - 1} repl{t.messages.length === 2 ? 'y' : 'ies'}
          </span>
        )}
        {t.stale && (
          <span className="stale">
            <AlertTriangle size="0.6875rem" /> stale
          </span>
        )}
        {t.resolved && (
          <span className="resolved">
            <Check size="0.6875rem" /> resolved
          </span>
        )}
        <button
          type="button"
          className={`ghost danger delete ${del.armed ? 'confirm' : 'icon'}`}
          title={del.armed ? 'Click again to delete this thread' : 'Delete this thread'}
          aria-label={del.armed ? 'Delete this thread? Click again to confirm' : 'Delete this thread'}
          onClick={(e) => {
            e.stopPropagation();
            del.fire();
          }}
        >
          <Trash2 size="0.75rem" />
          {del.armed && 'Delete?'}
        </button>
      </div>
      <div className="content">
        <div className="quote">{firstLine(t.anchor.quoted)}</div>
        <Markdown text={first?.body ?? ''} path={t.anchor.path} />
      </div>
    </div>
  );
});

/** Button that briefly morphs into a check mark after a successful copy. */
function CopyButton({
  label,
  icon,
  onCopy,
  primary,
  disabled,
  title,
}: {
  label: string;
  icon: React.ReactNode;
  onCopy: () => Promise<boolean>;
  primary?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return (
    <button
      className={`copy-btn ${primary ? 'primary' : ''} ${done ? 'done' : ''}`}
      disabled={disabled}
      title={title}
      onClick={async () => {
        if (!(await onCopy())) return;
        setDone(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setDone(false), 1400);
      }}
    >
      <span className="copy-icon">
        <span className="i">{icon}</span>
        <span className="ok">
          <Check size="0.875rem" />
        </span>
      </span>
      {done ? 'Copied' : label}
    </button>
  );
}

function cmp(a: CommentThread, b: CommentThread): number {
  if (a.anchor.path !== b.anchor.path) return a.anchor.path < b.anchor.path ? -1 : 1;
  return a.anchor.startLine - b.anchor.startLine || (a.messages[0]?.createdAt ?? 0) - (b.messages[0]?.createdAt ?? 0);
}

function firstLine(s: string): string {
  const [l = ''] = s.split('\n');
  const t = l.trim();
  return t.length > 70 ? t.slice(0, 70) + '…' : t;
}
