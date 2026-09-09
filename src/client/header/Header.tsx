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
import type { LspServerStatus, LspStatus } from '../../shared/protocol.js';
import { repoName } from '../model.js';
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
      <span className="root" title={snapshot?.mode.pullRequest?.repository ?? snapshot?.root}>
        {snapshot ? repoName(snapshot) : ''}
      </span>
      <ModePicker />
      <span className="stat">
        {changed} files · <span style={{ color: 'var(--add)' }}>+{adds}</span>{' '}
        <span style={{ color: 'var(--del)' }}>−{dels}</span>
      </span>
      <span className="spacer" />
      {lsp.enabled && <LspIndicator lsp={lsp} />}
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

/**
 * Every language server at a glance: the spinner runs while any of them starts or
 * indexes, and the tooltip lists them with the languages nothing serves.
 */
function LspIndicator({ lsp }: { lsp: LspStatus }) {
  const starting = lsp.servers.filter((s) => s.state === 'starting');
  const indexing = lsp.servers.filter((s) => s.indexing);
  const broken = lsp.servers.filter((s) => s.state === 'unavailable');
  const busy = starting.length > 0 || indexing.length > 0;
  const state =
    lsp.servers.length === 0
      ? 'off'
      : broken.length === lsp.servers.length
        ? 'unavailable'
        : busy
          ? 'starting'
          : 'ready';
  const label = starting.length
    ? 'starting'
    : indexing.length
      ? 'indexing'
      : state === 'unavailable'
        ? 'unavailable'
        : '';
  const lines = [
    ...lsp.servers.map((s) => `${s.name} (${s.languages.join(', ')}): ${serverLabel(s)}`),
    ...lsp.missing
      .filter((m) => m.tried.length)
      .map((m) => `${m.language}: nothing on PATH, tried ${m.tried.join(', ')}`),
  ];
  return (
    <span className={`lsp ${state}`} title={lines.join('\n') || 'No language server for the files in this diff'}>
      {busy ? <LoaderCircle size="0.875rem" className="spin" /> : <Compass size="0.875rem" />}
      {label}
    </span>
  );
}

function serverLabel(s: LspServerStatus): string {
  if (s.state === 'unavailable') return `unavailable: ${s.message ?? 'unknown error'}`;
  // Only while indexing does the reader need to distrust an answer: references can still be missing.
  if (s.indexing) return 'indexing the repository, so references in unchanged files are incomplete';
  return s.state;
}

function ThemeIcon({ choice }: { choice: ThemeChoice }) {
  if (choice === 'light') return <Sun size="1rem" />;
  if (choice === 'dark') return <Moon size="1rem" />;
  return <Monitor size="1rem" />;
}
