import { twMerge } from 'tailwind-merge';
import { Button } from '@/client/ui/Button.js';
import { AlertTriangle, Check, MessageSquare, Trash2 } from 'lucide-react';
import { memo } from 'react';
import type { CommentThread, Side } from '@/shared/protocol.js';
import { anchorLabel } from '@/client/model.js';
import { Markdown } from '@/client/Markdown.js';
import { ButtonLabel } from '@/client/ui/ButtonLabel.js';
import { useConfirm } from '@/client/useConfirm.js';

/**
 * One thread. Memoized on the thread object and the store's stable actions, so
 * header-only changes (the active file, confirm timers) leave Markdown bodies alone.
 */
export const ThreadRow = memo(function ThreadRow({
  thread: t,
  openFile,
  focusThread,
  deleteThread,
}: {
  thread: CommentThread;
  openFile: (path: string, line?: number, side?: Side) => Promise<void>;
  focusThread: (id: string | null) => void;
  deleteThread: (id: string) => Promise<void>;
}) {
  const first = t.messages[0];
  const del = useConfirm(() => void deleteThread(t.id));
  const open = () => {
    // A file thread's card sits above the file's first line, where opening the file lands.
    if (t.anchor.kind === 'line') void openFile(t.anchor.path, t.anchor.endLine, t.anchor.side);
    else void openFile(t.anchor.path);
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
        <span className="font-mono font-semibold text-foreground">{anchorLabel(t.anchor)}</span>
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
          className="ml-auto px-0.75 py-[1px] opacity-0 group-focus-within/thread:opacity-100 group-hover/thread:opacity-100 data-[feedback=confirm]:opacity-100"
          title={del.armed ? 'Click again to delete this thread' : 'Delete this thread'}
          aria-label={del.armed ? 'Delete this thread? Click again to confirm' : 'Delete this thread'}
          onClick={(e) => {
            e.stopPropagation();
            del.fire();
          }}
        >
          <Trash2 size="0.75rem" />
          <ButtonLabel text={del.armed && 'Delete?'} />
        </Button>
      </div>
      <div className="px-2.5 pt-1.5 pb-2 [&>.markdown]:font-sans [&>.markdown]:text-[0.8125rem] [&>.markdown]:leading-[1.4] [&>.markdown]:[word-break:break-word]">
        {t.anchor.kind === 'line' && (
          <div className="m-0 mb-1.5 overflow-hidden font-mono text-[0.75rem] leading-[1.4] text-ellipsis whitespace-nowrap text-muted">
            {firstLine(t.anchor.quoted)}
          </div>
        )}
        <Markdown
          text={first?.body ?? ''}
          path={t.anchor.path}
          quoted={t.anchor.kind === 'line' ? t.anchor.quoted : undefined}
        />
      </div>
    </div>
  );
});

function firstLine(s: string): string {
  const [l = ''] = s.split('\n');
  const t = l.trim();
  return t.length > 70 ? t.slice(0, 70) + '…' : t;
}
