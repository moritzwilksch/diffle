import { useEffect, useRef, useState } from 'react';
import { composerKey } from '@/client/model.js';
import { useStore } from '@/client/store.js';
import { Button } from '@/client/ui/Button.js';
import { TextArea } from '@/client/ui/TextArea.js';

export function ReplyComposer({ threadId }: { threadId: string }) {
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
    <div
      className="@container mx-2.5 mt-0 mb-2.5 rounded-md border border-accent bg-surface p-2"
      onClick={(event) => event.stopPropagation()}
    >
      <TextArea
        className="min-h-17.5 w-full resize-y rounded-sm border border-border bg-canvas p-1.5 font-mono text-[0.75rem] leading-[1.5]"
        ref={ref}
        value={text}
        placeholder="Reply…"
        onValueChange={setText}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') {
            event.stopPropagation();
            closeReply();
          } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
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
