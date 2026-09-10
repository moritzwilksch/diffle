import { ToggleButton } from '../ui/ToggleButton.js';
import { twMerge } from 'tailwind-merge';
import { Button } from '../ui/Button.js';
import {
  Check,
  CircleAlert,
  CircleOff,
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
 * indexes. Expand it for workspace health, commands, and logs.
 */
function LspIndicator({ lsp }: { lsp: LspStatus }) {
  const starting = lsp.servers.some((s) => s.state === 'starting');
  const busy = starting || lsp.servers.some((s) => s.activity?.length);
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
  return (
    <details className={`lsp-details ${error || broken ? 'has-error' : ''}`}>
      <summary className={`lsp ${state}`} aria-label={`Language servers${label ? `: ${label}` : ''}`}>
        {busy ? <LoaderCircle size="0.875rem" className="spin" /> : <Compass size="0.875rem" />}
        {label}
      </summary>
      <section className="lsp-panel" aria-label="Language server status">
        <strong>Language servers</strong>
        {lsp.servers.map((s) => (
          <ServerStatus key={s.command} server={s} />
        ))}
        {!lsp.servers.length && !lsp.missing.length && <p className="lsp-muted">No servers</p>}
        {lsp.missing.map((m) => (
          <div className="lsp-server lsp-missing" key={m.language} title={m.tried.join(', ')}>
            <CircleOff size="0.875rem" />
            <span className="lsp-name">{m.language}</span>
            <span className="lsp-badge">{m.tried.length ? 'Not on PATH' : 'Disabled'}</span>
          </div>
        ))}
      </section>
    </details>
  );
}

function ServerStatus({ server: s }: { server: LspServerStatus }) {
  const busy = s.state === 'starting' || !!s.activity?.length;
  const problem = s.state === 'unavailable' || !!s.notice;
  const label =
    s.state === 'unavailable' ? 'Unavailable' : s.state === 'starting' ? 'Starting' : busy ? 'Working' : 'Connected';
  return (
    <div className="lsp-server">
      <div className={`lsp-server-row ${problem ? 'lsp-problem' : busy ? 'lsp-working' : 'lsp-connected'}`}>
        {busy ? (
          <LoaderCircle size="0.875rem" className="spin" />
        ) : problem ? (
          <CircleAlert size="0.875rem" />
        ) : (
          <Check size="0.875rem" />
        )}
        <strong className="lsp-name">{s.name}</strong>
        <span
          className="lsp-badge"
          title={label === 'Connected' ? 'Initialized; workspace readiness is not reported by LSP' : undefined}
        >
          {label}
        </span>
      </div>
      <div className="lsp-languages">{s.languages.join(', ')}</div>
      {s.activity?.map((activity, i) => (
        <p className="lsp-activity" key={i}>
          {activity}
        </p>
      ))}
      {s.message && <p className="lsp-problem lsp-message">{s.message}</p>}
      {s.notice && <p className="lsp-problem lsp-message">{s.notice.message}</p>}
      <details className="lsp-diagnostics">
        <summary>Details</summary>
        <pre>{s.command}</pre>
        {s.stderr && (
          <>
            <span className="lsp-muted">stderr</span>
            <pre>{s.stderr}</pre>
          </>
        )}
      </details>
    </div>
  );
}

function ThemeIcon({ choice }: { choice: ThemeChoice }) {
  if (choice === 'light') return <Sun size="1rem" />;
  if (choice === 'dark') return <Moon size="1rem" />;
  return <Monitor size="1rem" />;
}
