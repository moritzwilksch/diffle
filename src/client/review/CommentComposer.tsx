import { Button } from '../ui/Button.js';
import { FileDiff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store.js';

/** Inline comment editor rendered as an annotation at the selection's last line. */
export function CommentComposer({ lines }: { lines: string }) {
  const submitDraft = useStore((s) => s.submitDraft);
  const closeDraft = useStore((s) => s.closeDraft);
  const draftQuote = useStore((s) => s.draftQuote);
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
      await submitDraft(text);
    } finally {
      setBusy(false);
    }
  };

  // A ```suggestion fence prefilled with the selected lines; the export renders it as ORIGINAL / SUGGESTED.
  const suggest = async () => {
    const quoted = await draftQuote();
    const block = `\`\`\`suggestion\n${quoted}\n\`\`\``;
    setText((t) => (t.trim() ? `${t.replace(/\s+$/, '')}\n\n${block}\n` : `${block}\n`));
    ref.current?.focus();
  };

  return (
    <div className="font-sans text-[0.8125rem] my-1 mx-2 border border-accent rounded-md bg-surface p-2">
      <textarea
        className="w-full min-h-17.5 resize-y border border-border rounded p-1.5 bg-canvas font-mono text-[0.75rem] leading-[1.5]"
        ref={ref}
        value={text}
        placeholder={`Comment on ${lines}…`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') closeDraft();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
        }}
      />
      <div className="flex gap-1.5 justify-end mt-1.5 items-center">
        <span className="text-muted text-[0.75rem] mr-auto">
          <kbd>⌘/Ctrl</kbd>+<kbd>Enter</kbd> to save · <kbd>Esc</kbd> to cancel
        </span>
        <Button
          variant="ghost"
          onClick={() => void suggest()}
          title="Insert the selected lines as a suggestion block to edit"
        >
          <FileDiff size="0.8125rem" /> Suggest change
        </Button>
        <Button onClick={closeDraft}>Cancel</Button>
        <Button variant="primary" onClick={() => void submit()} disabled={!text.trim() || busy}>
          Comment
        </Button>
      </div>
    </div>
  );
}
