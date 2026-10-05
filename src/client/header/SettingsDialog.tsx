import { Dialog } from '../ui/Dialog.js';
import { Button } from '../ui/Button.js';
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store.js';
import type { FollowRefs } from '../../shared/protocol.js';

const FOLLOW_REFS: [FollowRefs, string][] = [
  ['on', 'Always'],
  ['auto', 'Auto (not on branches)'],
  ['off', 'Never'],
];

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const [text, setText] = useState(config.autoViewed.join('\n'));
  const [context, setContext] = useState(String(config.contextLines));
  const [followRefs, setFollowRefs] = useState(config.followRefs);
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
      followRefs,
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
        Matching files start collapsed and viewed. One glob per line: <code>*.lock</code> matches a file name,{' '}
        <code>**/generated/**</code> a path.
      </p>
      <textarea
        className="min-h-40 w-full rounded-md border border-border bg-surface p-2 font-mono text-[0.75rem]"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        autoFocus
      />
      <h3 className="m-0 mt-[14px] mb-2">Context lines</h3>
      <p className="m-0 mb-2 text-muted">Unchanged lines around each change.</p>
      <input
        type="number"
        min={0}
        max={10000}
        value={context}
        onChange={(e) => setContext(e.target.value)}
        className="w-[100px]"
      />
      <h3 className="m-0 mt-[14px] mb-2">Reload behavior</h3>
      <p className="m-0 mb-2 text-muted">Reload when a compared ref moves.</p>
      <div role="radiogroup" aria-label="Reload behavior" className="flex flex-col gap-1">
        {FOLLOW_REFS.map(([value, label]) => (
          <label key={value} className="flex cursor-pointer items-center gap-1.5">
            <input
              type="radio"
              name="follow-refs"
              value={value}
              checked={followRefs === value}
              onChange={() => setFollowRefs(value)}
            />
            {label}
          </label>
        ))}
      </div>
      <h3 className="m-0 mt-[14px] mb-2">Language servers</h3>
      <p className="m-0 mb-2 text-muted">
        <code>diffle lsp</code> lists them; <code>diffle config set-lsp</code> overrides one.
      </p>
      {overrides.length > 0 && (
        <p className="m-0 mb-2 text-muted">
          Overrides:{' '}
          {overrides.map(([language, command], i) => (
            <span key={language}>
              {i > 0 && ', '}
              {language} <code>{command || '(off)'}</code>
            </span>
          ))}
        </p>
      )}
      <div className="mt-2.5 flex items-center gap-1.5">
        <span className="flex-1 text-[0.75rem] text-muted" title="Installed diffle version">
          diffle v{__DIFFLE_VERSION__}
        </span>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={save} disabled={saving}>
          Save
        </Button>
      </div>
    </Dialog>
  );
}
