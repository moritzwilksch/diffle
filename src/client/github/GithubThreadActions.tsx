import { useRef, useState } from 'react';
import { api } from '@/client/api.js';
import { Button } from '@/client/ui/Button.js';
import { TextArea } from '@/client/ui/TextArea.js';
import type { GithubCommentThread } from '@/shared/protocol.js';

export function GithubThreadActions({
  prUrl,
  thread,
  composing,
  setComposing,
  replyInHeader,
}: {
  prUrl: string;
  thread: GithubCommentThread;
  composing: boolean;
  setComposing: (composing: boolean) => void;
  replyInHeader?: boolean;
}) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const running = useRef(false);
  const canResolve = thread.isResolved ? thread.viewerCanUnresolve : thread.viewerCanResolve;
  if (!thread.viewerCanReply && !canResolve) return null;

  async function mutate(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  function submit() {
    if (!body.trim()) return;
    void mutate(async () => {
      await api.replyGithubThread(thread.id, prUrl, body);
      setBody('');
      setComposing(false);
    });
  }

  return (
    <div className="space-y-2 border-t border-border px-2 py-1.5">
      {composing && thread.viewerCanReply && (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <TextArea
            autoFocus
            aria-label="GitHub reply"
            placeholder="Reply to this thread…"
            value={body}
            onValueChange={setBody}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.nativeEvent.isComposing) return;
              event.preventDefault();
              submit();
            }}
            disabled={busy}
            className="block min-h-16 w-full resize-y rounded-sm border border-border bg-surface px-2 py-1"
          />
          <div className="flex flex-wrap gap-1.5">
            <Button type="submit" variant="primary" disabled={busy || !body.trim()} title="Ctrl+Enter or ⌘+Enter">
              Add reply to review
            </Button>
            <Button type="button" disabled={busy} onClick={() => setComposing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      <div className="flex flex-wrap gap-1.5">
        {thread.viewerCanReply && !composing && !replyInHeader && (
          <Button disabled={busy} onClick={() => setComposing(true)}>
            Reply
          </Button>
        )}
        {canResolve && (
          <Button
            disabled={busy}
            onClick={() => void mutate(() => api.resolveGithubThread(thread.id, prUrl, !thread.isResolved))}
          >
            {thread.isResolved ? 'Unresolve thread' : 'Resolve thread'}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-warn">
          {error}
        </p>
      )}
    </div>
  );
}
