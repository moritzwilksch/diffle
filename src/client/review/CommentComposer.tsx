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
    <div className="annotation composer">
      <textarea
        ref={ref}
        value={text}
        placeholder={`Comment on ${lines}…`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') closeDraft();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
        }}
      />
      <div className="row">
        <span className="hint">
          <kbd>⌘/Ctrl</kbd>+<kbd>Enter</kbd> to save · <kbd>Esc</kbd> to cancel
        </span>
        <button className="ghost" onClick={() => void suggest()} title="Insert the selected lines as a suggestion block to edit">
          <FileDiff size="0.8125rem" /> Suggest change
        </button>
        <button onClick={closeDraft}>Cancel</button>
        <button className="primary" onClick={() => void submit()} disabled={!text.trim() || busy}>
          Comment
        </button>
      </div>
    </div>
  );
}
