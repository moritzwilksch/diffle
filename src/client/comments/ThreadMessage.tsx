import { Bot, Copy, Pencil, Trash2, User, X } from 'lucide-react';
import type { CommentMessage, CommentThread } from '@/shared/protocol.js';
import { api } from '@/client/api.js';
import { useCopied } from '@/client/clipboard.js';
import { Markdown } from '@/client/Markdown.js';
import { composerKey } from '@/client/model.js';
import { useStore } from '@/client/store.js';
import { Button } from '@/client/ui/Button.js';
import { ButtonLabel } from '@/client/ui/ButtonLabel.js';
import { CopyIcon } from '@/client/ui/CopyIcon.js';
import { TextArea } from '@/client/ui/TextArea.js';
import { useConfirm } from '@/client/useConfirm.js';
import { CommentDate } from './CommentDate.js';
import { anchorPath } from './threads.js';

export function ThreadMessage({
  thread,
  message,
  first,
  editable,
}: {
  thread: CommentThread;
  message: CommentMessage;
  first: boolean;
  editable: boolean;
}) {
  const editMessage = useStore((s) => s.editMessage);
  const deleteMessage = useStore((s) => s.deleteMessage);
  const editing = useStore((s) => editable && s.editingId === message.id);
  const setEditingId = useStore((s) => s.setEditingId);
  // An edit left with Esc is kept and resumed on the next `e`; text equal to the body is no edit.
  const key = useStore((s) => composerKey(s, { kind: 'edit', messageId: message.id }));
  const text = useStore((s) => (key ? (s.unsent[key] ?? message.body) : message.body));
  const setUnsent = useStore((s) => s.setUnsent);
  const setText = (t: string) => key && setUnsent(key, t === message.body ? '' : t);
  const del = useConfirm(() => void deleteMessage(thread.id, message.id));
  const save = () => {
    void editMessage(thread.id, message.id, text);
    setEditingId(null);
  };
  const agent = message.author === 'agent';
  return (
    <div className="group/message px-2.5 pt-2 pb-1 last:pb-2.5">
      <div className="flex items-center gap-2">
        <span
          className={`flex size-5 flex-none items-center justify-center rounded-full ${agent ? 'bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-accent' : 'bg-hover text-muted'}`}
        >
          {agent ? <Bot size="0.75rem" /> : <User size="0.75rem" />}
        </span>
        <span className="text-[0.75rem] font-semibold text-foreground">{agent ? 'Agent' : 'You'}</span>
        <span className="text-[0.75rem] text-muted">
          <CommentDate createdAt={message.createdAt} />
          {message.updatedAt > message.createdAt && ' · edited'}
        </span>
        <span className="flex-1" />
        {/* Hidden until the message is hovered or focused, unless an edit or a delete is in flight. */}
        <div
          className={`flex items-center gap-0.5 group-focus-within/message:opacity-100 group-hover/message:opacity-100 ${editing || del.armed ? '' : 'opacity-0'}`}
        >
          <CopyMessageButton threadId={thread.id} messageId={message.id} size="0.75rem" />
          {editable && (
            <Button
              variant="ghost"
              icon
              onClick={() => setEditingId(editing ? null : message.id)}
              title={editing ? 'Cancel' : 'Edit (e)'}
            >
              {editing ? <X size="0.75rem" /> : <Pencil size="0.75rem" />}
            </Button>
          )}
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
              <ButtonLabel text={del.armed && 'Delete?'} />
            </Button>
          )}
        </div>
      </div>
      {/* Indented past the avatar, under the name. */}
      <div className="pl-7">
        {editing ? (
          <div className="rounded-md border-0 bg-surface p-0">
            <TextArea
              className="min-h-17.5 w-full resize-y rounded-sm border border-border bg-canvas p-1.5 font-mono text-[0.75rem] leading-[1.5]"
              value={text}
              onValueChange={setText}
              onKeyDown={(e) => {
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
          <Markdown
            text={message.body}
            path={anchorPath(thread.anchor) ?? undefined}
            quoted={thread.anchor.kind === 'line' ? thread.anchor.quoted : undefined}
          />
        )}
      </div>
    </div>
  );
}

/** Copies one message in agent-prompt format; the icon morphs into a check mark after success. */
function CopyMessageButton({ threadId, messageId, size }: { threadId: string; messageId: string; size: string }) {
  const flash = useStore((s) => s.flash);
  const report = useStore((s) => s.report);
  const { done, copy } = useCopied();
  return (
    <Button
      variant="ghost"
      icon
      feedback={done ? 'copied' : undefined}
      className="relative"
      title="Copy this comment as a prompt"
      onClick={async () => {
        let text: string;
        try {
          text = await api.exportComment(threadId, messageId);
        } catch (e) {
          report('Copying comment', e);
          return;
        }
        if (!(await copy(text))) flash('The browser blocked clipboard access');
      }}
    >
      <CopyIcon done={done} size={size}>
        <Copy size={size} />
      </CopyIcon>
    </Button>
  );
}
