import { Button } from '../ui/Button.js';
import { FileDiff } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '../store.js';

/** Inline comment editor rendered as an annotation at the selection's last line. */
export function CommentComposer({ lines }: { lines: string }) {
  const submitDraft = useStore((s) => s.submitDraft);
  const closeDraft = useStore((s) => s.closeDraft);
  const draftQuote = useStore((s) => s.draftQuote);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const textarea = ref.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    const style = getComputedStyle(textarea);
    const borders = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    textarea.style.height = `${textarea.scrollHeight + borders}px`;
  }, [text]);

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
    <div className="mx-2 my-1 rounded-md border border-accent bg-surface p-2 font-sans text-[0.8125rem]">
      <textarea
        className="max-h-[60vh] min-h-17.5 w-full resize-y rounded-sm border border-border bg-canvas p-1.5 font-mono text-[0.75rem] leading-[1.5]"
        ref={ref}
        value={text}
        placeholder={`Comment on ${lines}…`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') closeDraft();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
        }}
      />
      <div className="mt-1.5 flex items-center justify-end gap-1.5">
        <span className="mr-auto text-[0.75rem] text-muted">
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
