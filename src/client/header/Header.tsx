import {
  Columns2,
  Compass,
  GitCompareArrows,
  Keyboard,
  LoaderCircle,
  Monitor,
  Moon,
  PanelLeft,
  PanelRight,
  Rows3,
  Settings,
  Sun,
} from 'lucide-react';
import { useState } from 'react';
import type { LspStatus } from '../../shared/protocol.js';
import { useStore } from '../store.js';
import { nextTheme, type ThemeChoice } from '../theme.js';
import { ModePicker } from './ModePicker.js';
import { SettingsDialog } from './SettingsDialog.js';

export function Header() {
  const snapshot = useStore((s) => s.snapshot);
  const lsp = useStore((s) => s.lsp);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const layout = useStore((s) => s.layout);
  const setLayout = useStore((s) => s.setLayout);
  const diffStyle = useStore((s) => s.diffStyle);
  const setDiffStyle = useStore((s) => s.setDiffStyle);
  const changed = snapshot?.changed.length ?? 0;
  const adds = snapshot?.changed.reduce((n, f) => n + f.additions, 0) ?? 0;
  const dels = snapshot?.changed.reduce((n, f) => n + f.deletions, 0) ?? 0;

  return (
    <header className="header">
      <button
        className={`ghost icon ${layout.treeVisible ? '' : 'off'}`}
        onClick={() => setLayout({ treeVisible: !layout.treeVisible })}
        title="Toggle file tree (⌘/Ctrl+b)"
      >
        <PanelLeft size="1rem" />
      </button>
      <span className="brand">
        <GitCompareArrows size="1rem" /> diffle
      </span>
      <span className="root" title={snapshot?.mode.repository ?? snapshot?.root}>
        {snapshot ? (snapshot.mode.repository ?? basename(snapshot.root)) : ''}
      </span>
      <ModePicker />
      <span className="stat">
        {changed} files · <span style={{ color: 'var(--add)' }}>+{adds}</span>{' '}
        <span style={{ color: 'var(--del)' }}>−{dels}</span>
      </span>
      <span className="spacer" />
      {lsp.state !== 'off' && <LspIndicator lsp={lsp} />}
      <div className="toggle" title="Diff layout">
        <button className={diffStyle === 'split' ? 'on' : ''} onClick={() => setDiffStyle('split')}>
          <Columns2 size="0.875rem" /> Split
        </button>
        <button className={diffStyle === 'unified' ? 'on' : ''} onClick={() => setDiffStyle('unified')}>
          <Rows3 size="0.875rem" /> Unified
        </button>
      </div>
      <button className="ghost icon" onClick={() => setTheme(nextTheme(theme))} title={`Theme: ${theme} (t)`}>
        <ThemeIcon choice={theme} />
      </button>
      <button
        className="ghost icon"
        onClick={() => useStore.getState().setHelpOpen(true)}
        title="Keyboard shortcuts (?)"
      >
        <Keyboard size="1rem" />
      </button>
      <button className="ghost" onClick={() => setSettingsOpen(true)} title="Settings">
        <Settings size="0.9375rem" /> Settings
      </button>
      <button
        className={`ghost icon ${layout.panelVisible ? '' : 'off'}`}
        onClick={() => setLayout({ panelVisible: !layout.panelVisible })}
        title="Toggle comments panel (⌘/Ctrl+Shift+b)"
      >
        <PanelRight size="1rem" />
      </button>
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </header>
  );
}

/** Language server state at a glance; the spinner runs while it starts or indexes the workspace. */
function LspIndicator({ lsp }: { lsp: LspStatus }) {
  const busy = lsp.state === 'starting' || lsp.indexing === true;
  const label =
    lsp.state === 'starting'
      ? 'starting'
      : lsp.indexing
        ? 'indexing'
        : lsp.state === 'unavailable'
          ? 'unavailable'
          : '';
  const title =
    lsp.state === 'unavailable'
      ? `Language server unavailable: ${lsp.message ?? 'unknown error'}`
      : lsp.indexing
        ? 'Language server is indexing the repository; references in unchanged files are incomplete until it finishes'
        : `Language server: ${lsp.command}`;
  return (
    <span className={`lsp ${lsp.state}`} title={title}>
      {busy ? <LoaderCircle size="0.875rem" className="spin" /> : <Compass size="0.875rem" />}
      {label}
    </span>
  );
}

function ThemeIcon({ choice }: { choice: ThemeChoice }) {
  if (choice === 'light') return <Sun size="1rem" />;
  if (choice === 'dark') return <Moon size="1rem" />;
  return <Monitor size="1rem" />;
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
