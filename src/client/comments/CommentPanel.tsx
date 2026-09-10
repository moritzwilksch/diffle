import { Dialog } from '../ui/Dialog.js';
import { CopyIcon } from '../ui/CopyIcon.js';
import { twMerge } from 'tailwind-merge';
import { Button } from '../ui/Button.js';
import { AlertTriangle, Check, ClipboardCopy, GitPullRequestArrow, MessageSquare, Trash2 } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { CommentThread, Side } from '../../shared/protocol.js';
import { api } from '../api.js';
import { copyText } from '../clipboard.js';
import { canExportToGithub, exportLabel, type ExportOutcome, visibleThreads } from '../model.js';
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
  const canExport = useStore((s) => canExportToGithub(s.snapshot));
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
    <aside className="flex min-h-0 flex-col bg-surface">
      <div className="flex min-h-10 items-center gap-1.5 border-b border-b-border px-2.5 py-1.5 [&_button]:flex-none [&_button]:px-2 [&_button]:whitespace-nowrap">
        <span className="mr-auto inline-flex min-w-0 items-center gap-1.5 truncate font-semibold">
          <MessageSquare size="0.9375rem" /> Threads
          {open.length > 0 && (
            <span className="rounded-[0.625rem] bg-hover px-1.75 py-0 font-medium text-muted">{open.length}</span>
          )}
        </span>
        <CopyButton
          label="All"
          icon={<ClipboardCopy size="0.875rem" />}
          primary
          disabled={open.length === 0}
          title="Copy all open threads as a prompt (yy)"
          onCopy={() => copy()}
        />
        {canExport && (
          <Button
            variant="ghost"
            icon={!post.armed && !posted}
            feedback={post.armed ? 'confirm' : posted ? 'posted' : undefined}
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
          </Button>
        )}
        <Button
          variant="ghost"
          danger
          icon={!clear.armed}
          feedback={clear.armed ? 'confirm' : undefined}
          disabled={threads.length === 0}
          title={clear.armed ? 'Click again to delete all threads' : 'Delete all threads for this mode'}
          onClick={clear.fire}
        >
          <Trash2 size="0.875rem" />
          {clear.armed && 'Delete all?'}
        </Button>
      </div>
      {staleCount > 0 && (
        <div
          className="flex cursor-default items-center gap-1.5 border-b border-b-border px-2.5 py-1 text-[0.75rem] text-warn"
          title="Stale threads no longer point into the diff: their text changed or left the changed lines"
        >
          <AlertTriangle size="0.75rem" />
          {staleCount} stale
          <Button
            variant="ghost"
            danger
            feedback={stale.armed ? 'confirm' : undefined}
            className="ml-auto gap-1 px-1.5 py-px text-[0.75rem] leading-[1.2]"
            onClick={stale.fire}
          >
            <Trash2 size="0.75rem" />
            {stale.armed ? 'Delete stale?' : 'Delete'}
          </Button>
        </div>
      )}
      {resolvedCount > 0 && (
        <label
          className="flex cursor-pointer items-center gap-1.5 border-b border-b-border px-2.5 py-1 text-[0.75rem] text-muted"
          title="Resolved threads are kept but left out of the prompt"
        >
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
          Show {resolvedCount} resolved
        </label>
      )}
      <div className="flex flex-1 flex-col gap-3.5 overflow-auto p-2.5">
        {groups.length === 0 && (
          <div className="px-3 py-6 text-center text-muted [&>p]:mt-0 [&>p]:mr-0 [&>p]:mb-1.5 [&>p]:ml-0">
            <p>{threads.length ? 'Every thread is resolved.' : 'No comments yet.'}</p>
            <p>Click a line number to comment, or drag across line numbers for a block.</p>
          </div>
        )}
        {groups.map(([path, list]) => (
          <section
            className="[&+section]:border-t [&+section]:border-solid [&+section]:border-border [&+section]:pt-3"
            key={path}
          >
            <h4 className="m-0 mb-1.5 font-mono text-[0.75rem] leading-[1.4] text-muted">
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
        <Dialog label="Copy manually" onClose={() => setManual(null)}>
          <h3 className="m-0 mb-2">Copy manually</h3>
          <p className="m-0 mb-2 text-muted">
            The browser blocked clipboard access. Select the text below and press Ctrl/⌘+c.
          </p>
          <textarea
            className="min-h-40 w-full rounded-md border border-border bg-surface p-2 font-mono text-[0.75rem]"
            readOnly
            value={manual}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
          />
          <div className="mt-2.5 flex justify-end gap-1.5">
            <Button onClick={() => setManual(null)}>Close</Button>
          </div>
        </Dialog>
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
      className={twMerge(
        `group/thread mb-2 block w-full cursor-pointer overflow-hidden rounded-md border border-border bg-card p-0 text-left font-sans text-[0.8125rem] leading-[1.4] text-foreground shadow-card [transition:border-color_120ms_ease] hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-[1px] focus-visible:outline-accent focus-visible:outline-solid ${t.stale ? 'border-dashed' : ''} ${t.resolved ? 'opacity-65' : ''}`,
      )}
      onClick={open}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
    >
      <div className="flex items-center gap-2 border-b border-b-border bg-hover py-1 pr-1.5 pl-2.5 text-[0.75rem] text-muted [&>svg]:flex-none [&>svg]:text-accent">
        <MessageSquare size="0.8125rem" />
        <span className="font-mono font-semibold text-foreground">
          {t.anchor.side === 'old' ? 'removed ' : ''}L{t.anchor.startLine}
          {t.anchor.endLine !== t.anchor.startLine ? `–${t.anchor.endLine}` : ''}
        </span>
        {t.messages.length > 1 && (
          <span className="text-muted">
            {t.messages.length - 1} repl{t.messages.length === 2 ? 'y' : 'ies'}
          </span>
        )}
        {t.stale && (
          <span className="inline-flex items-center gap-0.75 font-sans text-[0.6875rem] leading-[normal] text-warn">
            <AlertTriangle size="0.6875rem" /> stale
          </span>
        )}
        {t.resolved && (
          <span className="inline-flex items-center gap-0.75 font-sans text-[0.6875rem] leading-[normal] text-add">
            <Check size="0.6875rem" /> resolved
          </span>
        )}
        <Button
          type="button"
          variant="ghost"
          danger
          icon={!del.armed}
          feedback={del.armed ? 'confirm' : undefined}
          className="ml-auto px-0.75 py-[1px] opacity-0 [transition:opacity_120ms_ease] group-focus-within/thread:opacity-100 group-hover/thread:opacity-100 data-[feedback=confirm]:opacity-100"
          title={del.armed ? 'Click again to delete this thread' : 'Delete this thread'}
          aria-label={del.armed ? 'Delete this thread? Click again to confirm' : 'Delete this thread'}
          onClick={(e) => {
            e.stopPropagation();
            del.fire();
          }}
        >
          <Trash2 size="0.75rem" />
          {del.armed && 'Delete?'}
        </Button>
      </div>
      <div className="px-2.5 pt-1.5 pb-2 [&>.markdown]:font-sans [&>.markdown]:text-[0.8125rem] [&>.markdown]:leading-[1.4] [&>.markdown]:[word-break:break-word]">
        <div className="m-0 mb-1.5 overflow-hidden font-mono text-[0.75rem] leading-[1.4] text-ellipsis whitespace-nowrap text-muted">
          {firstLine(t.anchor.quoted)}
        </div>
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
    <Button
      variant={primary ? 'primary' : 'default'}
      feedback={done ? 'copied' : undefined}
      className="relative [transition:background_160ms_ease,_color_160ms_ease,_border-color_160ms_ease]"
      disabled={disabled}
      title={title}
      onClick={async () => {
        if (!(await onCopy())) return;
        setDone(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setDone(false), 1400);
      }}
    >
      <CopyIcon done={done}>{icon}</CopyIcon>
      {done ? 'Copied' : label}
    </Button>
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
