import { Dialog, DialogContent } from '@/client/ui/dialog.js';
import { CopyIcon } from '@/client/ui/CopyIcon.js';
import { Button } from '@/client/ui/Button.js';
import { AlertTriangle, Check, ClipboardCopy, GitPullRequestArrow, MessageSquare, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CommentThread } from '@/shared/protocol.js';
import { api } from '@/client/api.js';
import { copyText } from '@/client/clipboard.js';
import { commentsOff, exportLabel, type ExportOutcome, visibleThreads } from '@/client/model.js';
import { useStore } from '@/client/store.js';
import { FilePath } from '@/client/FilePath.js';
import { ButtonLabel } from '@/client/ui/ButtonLabel.js';
import { useConfirm } from '@/client/useConfirm.js';
import { CommitNavigator } from './CommitNavigator.js';
import { IterationList } from './IterationList.js';
import { ThreadRow } from './ThreadRow.js';

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
  const canExport = useStore((s) => s.github.data?.reason === null);
  const copiedAll = useStore((s) => s.copiedAll);
  const snapshot = useStore((s) => s.snapshot);
  const off = snapshot ? commentsOff(snapshot.mode) : null;
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
      {snapshot && (
        // Keyed by the range, so focusing one of its commits keeps the list as it was.
        <CommitNavigator key={(snapshot.mode.within ?? snapshot.mode).commentKey} snapshot={snapshot} />
      )}
      {snapshot && <IterationList snapshot={snapshot} />}
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
          pulse={copiedAll}
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
            <ButtonLabel text={post.armed ? 'Add all?' : posted && exportLabel(posted)} />
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
          <ButtonLabel text={clear.armed && 'Delete all?'} />
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
            <ButtonLabel text={stale.armed ? 'Delete stale?' : 'Delete'} />
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
            <p>
              {off ??
                'Click a line number to comment, drag across line numbers for a block, or press C for a whole file.'}
            </p>
          </div>
        )}
        {groups.map(([path, list]) => (
          <section
            className="border-0 [&+section]:border-t [&+section]:border-solid [&+section]:border-border [&+section]:pt-3"
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
        <Dialog open onOpenChange={() => setManual(null)}>
          <DialogContent aria-label="Copy manually">
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
          </DialogContent>
        </Dialog>
      )}
    </aside>
  );
}

/**
 * Button that briefly morphs into a check mark after a successful copy. A change of `pulse`
 * plays the same acknowledgement for a copy made elsewhere, such as by a keyboard chord.
 */
function CopyButton({
  label,
  icon,
  onCopy,
  pulse,
  primary,
  disabled,
  title,
}: {
  label: string;
  icon: React.ReactNode;
  onCopy: () => Promise<boolean>;
  pulse?: number;
  primary?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const acknowledge = () => {
    setDone(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setDone(false), 1400);
  };
  const seen = useRef(pulse);
  useEffect(() => {
    if (pulse === seen.current) return;
    seen.current = pulse;
    acknowledge();
  }, [pulse]);
  return (
    <Button
      variant={primary ? 'primary' : 'default'}
      feedback={done ? 'copied' : undefined}
      className="relative"
      disabled={disabled}
      title={title}
      onClick={async () => {
        if (await onCopy()) acknowledge();
      }}
    >
      <CopyIcon done={done}>{icon}</CopyIcon>
      <ButtonLabel text={done ? 'Copied' : label} />
    </Button>
  );
}

/** Review order: by path, then line with the file thread first, then creation. */
function cmp(a: CommentThread, b: CommentThread): number {
  if (a.anchor.path !== b.anchor.path) return a.anchor.path < b.anchor.path ? -1 : 1;
  const line = (x: CommentThread) => (x.anchor.kind === 'line' ? x.anchor.startLine : 0);
  return line(a) - line(b) || (a.messages[0]?.createdAt ?? 0) - (b.messages[0]?.createdAt ?? 0);
}
