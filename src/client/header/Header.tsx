import { ToggleButton } from '../ui/ToggleButton.js';
import { twMerge } from 'tailwind-merge';
import { Button } from '../ui/Button.js';
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
    <header className="col-span-full flex items-center gap-2.5 border-b border-b-border bg-surface px-3 py-0">
      <Button
        variant="ghost"
        icon
        className={layout.treeVisible ? '' : 'opacity-45'}
        onClick={() => setLayout({ treeVisible: !layout.treeVisible })}
        title="Toggle file tree (⌘/Ctrl+b)"
      >
        <PanelLeft size="1rem" />
      </Button>
      <span className="inline-flex items-center gap-1.5 font-bold tracking-[0.02em]">
        <GitCompareArrows size="1rem" /> diffle
      </span>
      <span
        className="truncate font-mono text-[0.75rem] text-muted"
        title={snapshot?.mode.pullRequest?.repository ?? snapshot?.root}
      >
        {snapshot ? repoName(snapshot) : ''}
      </span>
      <ModePicker />
      <span className="text-muted">
        {changed} files · <span className="text-add">+{adds}</span> <span className="text-del">−{dels}</span>
      </span>
      <span className="flex-1" />
      {lsp.enabled && <LspIndicator lsp={lsp} />}
      <div className="flex overflow-hidden rounded-md border border-border" title="Diff layout">
        <ToggleButton selected={diffStyle === 'split'} onClick={() => setDiffStyle('split')}>
          <Columns2 size="0.875rem" /> Split
        </ToggleButton>
        <ToggleButton selected={diffStyle === 'unified'} onClick={() => setDiffStyle('unified')}>
          <Rows3 size="0.875rem" /> Unified
        </ToggleButton>
      </div>
      <Button variant="ghost" icon onClick={() => setTheme(nextTheme(theme))} title={`Theme: ${theme} (t)`}>
        <ThemeIcon choice={theme} />
      </Button>
      <Button variant="ghost" icon onClick={() => useStore.getState().setHelpOpen(true)} title="Keyboard shortcuts (?)">
        <Keyboard size="1rem" />
      </Button>
      <Button variant="ghost" onClick={() => setSettingsOpen(true)} title="Settings">
        <Settings size="0.9375rem" /> Settings
      </Button>
      <Button
        variant="ghost"
        icon
        className={layout.panelVisible ? '' : 'opacity-45'}
        onClick={() => setLayout({ panelVisible: !layout.panelVisible })}
        title="Toggle comments panel (⌘/Ctrl+Shift+b)"
      >
        <PanelRight size="1rem" />
      </Button>
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </header>
  );
}

/**
 * Every language server at a glance: the spinner runs while any of them starts or
 * indexes, and the tooltip lists them with the languages nothing serves.
 */
function LspIndicator({ lsp }: { lsp: LspStatus }) {
  const starting = lsp.servers.some((s) => s.state === 'starting');
  const busy = starting || lsp.servers.some((s) => s.activity?.length || s.indexing);
  const broken = lsp.servers.some((s) => s.state === 'unavailable');
  const error = lsp.servers.some((s) => s.notice?.severity === 'error');
  const warning = lsp.servers.some((s) => s.notice?.severity === 'warning');
  const logs = lsp.servers.some((s) => s.stderr);
  const state = !lsp.servers.length ? 'off' : broken ? 'unavailable' : busy ? 'starting' : 'ready';
  const label =
    (broken && 'unavailable') ||
    (error && 'error') ||
    (warning && 'warning') ||
    (starting && 'starting') ||
    (busy && 'busy') ||
    (logs && 'logs') ||
    '';
  const lines = [
    ...lsp.servers.map((s) => `${s.name} (${s.languages.join(', ')}): ${serverLabel(s)}`),
    ...lsp.missing
      .filter((m) => m.tried.length)
      .map((m) => `${m.language}: nothing on PATH, tried ${m.tried.join(', ')}`),
  ];
  return (
    <span
      className={twMerge(
        `inline-flex items-center gap-1.25 text-[0.75rem] whitespace-nowrap text-muted ${state === 'unavailable' ? 'text-warn' : ''}`,
      )}
      title={lines.join('\n') || 'No language server for the files in this diff'}
    >
      {busy ? (
        <LoaderCircle size="0.875rem" className="animate-[spin_900ms_linear_infinite]" />
      ) : (
        <Compass size="0.875rem" />
      )}
      {label}
    </span>
  );
}

function serverLabel(s: LspServerStatus): string {
  const status =
    s.state === 'unavailable'
      ? `unavailable: ${s.message ?? 'unknown error'}`
      : s.state === 'starting'
        ? 'starting'
        : s.activity?.length
          ? s.activity.join('; ')
          : s.indexing
            ? 'indexing the repository, so references in unchanged files are incomplete'
            : 'connected';
  return [
    status,
    s.notice && `${s.notice.severity}: ${s.notice.message}`,
    s.stderr && `Last stderr output:\n${s.stderr}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function ThemeIcon({ choice }: { choice: ThemeChoice }) {
  if (choice === 'light') return <Sun size="1rem" />;
  if (choice === 'dark') return <Moon size="1rem" />;
  return <Monitor size="1rem" />;
}
