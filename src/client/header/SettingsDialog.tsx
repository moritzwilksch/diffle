import { Dialog, DialogContent } from '@/client/ui/dialog.js';
import { Button } from '@/client/ui/Button.js';
import { TextArea } from '@/client/ui/TextArea.js';
import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/client/store.js';
import { FONT_SIZE_MAX, FONT_SIZE_MIN, TEXT_SCALES, type BlameMode, type FollowRefs } from '@/shared/protocol.js';

const FOLLOW_REFS: [FollowRefs, string][] = [
  ['on', 'Always'],
  ['auto', 'Auto (not on branches)'],
  ['off', 'Never'],
];

const BLAME: [BlameMode, string][] = [
  ['inline', 'After the current line'],
  ['gutter', 'Beside every line number'],
  ['off', 'Off'],
];

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const [initial] = useState(config);
  const [text, setText] = useState(initial.autoViewed.join('\n'));
  const [context, setContext] = useState(String(initial.contextLines));
  const [followRefs, setFollowRefs] = useState(initial.followRefs);
  const [lineWrap, setLineWrap] = useState(initial.lineWrap);
  const [blame, setBlame] = useState(initial.blame);
  const [textScale, setTextScale] = useState(initial.textScale);
  const [editorSize, setEditorSize] = useState(initial.editorFontSize?.toString() ?? '');
  const [terminalSize, setTerminalSize] = useState(initial.terminalFontSize?.toString() ?? '');
  const fontSizes = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState(false);
  const overrides = Object.entries(config.lspCommands).sort(([a], [b]) => a.localeCompare(b));

  const save = async () => {
    const invalid = fontSizes.current?.querySelector<HTMLInputElement>('input:invalid');
    if (invalid) {
      invalid.reportValidity();
      return;
    }
    const contextLines = Math.max(0, Number.parseInt(context, 10) || 0);
    const editorFontSize = editorSize === '' ? null : Number(editorSize);
    const terminalFontSize = terminalSize === '' ? null : Number(terminalSize);
    const patch = {
      autoViewed:
        text === initial.autoViewed.join('\n')
          ? undefined
          : text
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean),
      contextLines: contextLines === initial.contextLines ? undefined : contextLines,
      followRefs: followRefs === initial.followRefs ? undefined : followRefs,
      lineWrap: lineWrap === initial.lineWrap ? undefined : lineWrap,
      blame: blame === initial.blame ? undefined : blame,
      textScale: textScale === initial.textScale ? undefined : textScale,
      editorFontSize: editorFontSize === initial.editorFontSize ? undefined : editorFontSize,
      terminalFontSize: terminalFontSize === initial.terminalFontSize ? undefined : terminalFontSize,
    };
    setSaving(true);
    const saved = Object.values(patch).every((value) => value === undefined) || (await saveConfig(patch));
    setSaving(false);
    if (saved) onClose();
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
    <Dialog open onOpenChange={onClose}>
      <DialogContent
        aria-label="Settings"
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto [&_code]:rounded-sm [&_code]:bg-hover [&_code]:px-1 [&_code]:font-mono"
      >
        <h3 className="m-0 mb-2">Auto-viewed patterns</h3>
        <p className="m-0 mb-2 text-muted">
          Matching files start collapsed and viewed. One glob per line: <code>*.lock</code> matches a file name,{' '}
          <code>**/generated/**</code> a path.
        </p>
        <TextArea
          className="min-h-40 w-full rounded-md border border-border bg-surface p-2 font-mono text-[0.75rem]"
          value={text}
          onValueChange={setText}
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
        <h3 className="m-0 mt-[14px] mb-2">Long lines</h3>
        <label className="flex cursor-pointer items-center gap-1.5">
          <input type="checkbox" checked={lineWrap} onChange={(e) => setLineWrap(e.target.checked)} />
          Wrap long lines
          <span className="text-muted">
            (toggle with <code>zw</code>)
          </span>
        </label>
        <h3 className="m-0 mt-[14px] mb-2">Git blame</h3>
        <p className="m-0 mb-2 text-muted">
          Who last changed a line (cycle with <code>gb</code>).
        </p>
        <div role="radiogroup" aria-label="Git blame" className="flex flex-col gap-1">
          {BLAME.map(([value, label]) => (
            <label key={value} className="flex cursor-pointer items-center gap-1.5">
              <input
                type="radio"
                name="blame"
                value={value}
                checked={blame === value}
                onChange={() => setBlame(value)}
              />
              {label}
            </label>
          ))}
        </div>
        <h3 className="m-0 mt-[14px] mb-2">Text size</h3>
        <select aria-label="Text size" value={textScale} onChange={(e) => setTextScale(Number(e.target.value))}>
          {TEXT_SCALES.map((size) => (
            <option key={size} value={size}>
              {size === 100 ? '100% (default)' : `${size}%`}
            </option>
          ))}
        </select>
        <div ref={fontSizes} className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
          {(
            [
              ['Editor font size (px)', editorSize, setEditorSize],
              ['Terminal font size (px)', terminalSize, setTerminalSize],
            ] as const
          ).map(([label, size, setSize]) => (
            <label key={label} className="flex items-center gap-2">
              {label}
              <input
                type="number"
                min={FONT_SIZE_MIN}
                max={FONT_SIZE_MAX}
                placeholder="Auto"
                value={size}
                onChange={(e) => setSize(e.target.value)}
                className="w-16"
              />
            </label>
          ))}
        </div>
        <p className="m-0 mt-1 text-muted">Leave blank to follow the app’s text size.</p>
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
          <code>diffle lsp</code> lists them; <code>lspCommands</code> in the config file (<code>diffle config</code>{' '}
          prints its path) overrides one.
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
      </DialogContent>
    </Dialog>
  );
}
