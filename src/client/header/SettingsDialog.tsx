import { Dialog } from '../ui/Dialog.js';
import { Button } from '../ui/Button.js';
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store.js';

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const [text, setText] = useState(config.autoViewed.join('\n'));
  const [context, setContext] = useState(String(config.contextLines));
  const [saving, setSaving] = useState(false);
  const overrides = Object.entries(config.lspCommands).sort(([a], [b]) => a.localeCompare(b));

  const save = async () => {
    setSaving(true);
    await saveConfig({
      autoViewed: text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
      contextLines: Math.max(0, Number.parseInt(context, 10) || 0),
    });
    setSaving(false);
    onClose();
  };

  // Escape closes, Enter saves unless the cursor is in the textarea, where it
  // inserts a line. Registered on window in the capture phase so the dialog
  // wins over the global keymap, which also captures Escape on document.
  const latest = useRef({ save, onClose, saving });
  latest.current = { save, onClose, saving };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        latest.current.onClose();
        return;
      }
      if (e.key === 'Enter' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        if ((e.target as HTMLElement | null)?.tagName === 'TEXTAREA') return;
        e.preventDefault();
        e.stopPropagation();
        if (!latest.current.saving) void latest.current.save();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <Dialog
      label="Settings"
      onClose={onClose}
      className="[&_code]:rounded-sm [&_code]:bg-hover [&_code]:px-1 [&_code]:font-mono"
    >
      <h3 className="m-0 mb-2">Auto-viewed patterns</h3>
      <p className="m-0 mb-2 text-muted">
        Files matching these globs start collapsed and marked viewed. One per line. Patterns without a slash match the
        file name anywhere, e.g. <code>*.lock</code>; use <code>**/generated/**</code> for paths. Same as{' '}
        <code>diffle config add-auto-viewed</code>.
      </p>
      <textarea
        className="min-h-40 w-full rounded-md border border-border bg-surface p-2 font-mono text-[0.75rem]"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        autoFocus
      />
      <h3 className="m-0 mt-[14px] mb-2">Context lines</h3>
      <p className="m-0 mb-2 text-muted">
        Unchanged lines shown around each change (<code>git diff -U&lt;n&gt;</code>). Same as <code>--context</code> or{' '}
        <code>diffle config set-context</code>.
      </p>
      <input
        type="number"
        min={0}
        max={10000}
        value={context}
        onChange={(e) => setContext(e.target.value)}
        className="w-[100px]"
      />
      <h3 className="m-0 mt-[14px] mb-2">Language servers</h3>
      <p className="m-0 mb-2 text-muted">
        Go-to-definition, references and symbols come from a language server per language, found on <code>PATH</code>.{' '}
        <code>diffle lsp</code> lists what each language would get,{' '}
        <code>diffle config set-lsp &lt;language&gt; &lt;command&gt;</code> overrides one, and <code>--no-lsp</code>{' '}
        turns them off for a run. Commands are not editable here.
      </p>
      {overrides.length > 0 && (
        <p className="m-0 mb-2 text-muted">
          Overridden in your config:{' '}
          {overrides.map(([language, command], i) => (
            <span key={language}>
              {i > 0 && ', '}
              {language} <code>{command || '(off)'}</code>
            </span>
          ))}
        </p>
      )}
      <div className="mt-2.5 flex justify-end gap-1.5">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={save} disabled={saving}>
          Save
        </Button>
      </div>
    </Dialog>
  );
}
