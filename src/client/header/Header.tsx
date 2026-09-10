import { ToggleButton } from '../ui/ToggleButton.js';
import { twMerge } from 'tailwind-merge';
import { Button } from '../ui/Button.js';
import {
  X,
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
import { useEffect, useRef, useState } from 'react';
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
  const popup = useRef<HTMLDetailsElement>(null);
  const close = () => {
    if (!popup.current) return;
    popup.current.open = false;
    popup.current.querySelector('summary')?.focus();
  };
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const el = popup.current;
      if (el?.open && !el.contains(event.target as Node)) el.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !popup.current?.open) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, []);
  const starting = lsp.servers.some((s) => s.state === 'starting');
  const busy = starting || lsp.servers.some((s) => s.activity?.length);
  const broken = lsp.servers.some((s) => s.state === 'unavailable');
  const error = lsp.servers.some((s) => s.notice?.severity === 'error');
  const warning = lsp.servers.some((s) => s.notice?.severity === 'warning');
  const logs = lsp.servers.some((s) => s.stderr);
  const label =
    (broken && 'unavailable') ||
    (error && 'error') ||
    (warning && 'warning') ||
    (starting && 'starting') ||
    (busy && 'busy') ||
    (logs && 'logs') ||
    '';
  return (
    <details ref={popup} className="relative">
      <summary
        className={twMerge(
          `inline-flex cursor-pointer list-none items-center gap-1.25 text-xs whitespace-nowrap text-muted [&::-webkit-details-marker]:hidden ${error || broken ? 'text-warn' : ''}`,
        )}
        aria-label={`Language servers${label ? `: ${label}` : ''}`}
      >
        {busy ? <LoaderCircle size="0.875rem" className="animate-spin" /> : <Compass size="0.875rem" />}
        {label}
      </summary>
      <section
        className="absolute top-[calc(100%+0.75rem)] right-0 z-100 max-h-[65vh] w-[min(28rem,85vw)] overflow-auto rounded-lg border border-border bg-surface p-4 text-[0.8125rem] text-foreground shadow-lg"
        aria-label="Language server status"
      >
        <div className="flex items-center justify-between gap-2">
          <strong>Language servers</strong>
          <button
            type="button"
            aria-label="Close language server status"
            className="cursor-pointer rounded-sm p-1 text-muted hover:bg-hover hover:text-foreground"
            onClick={close}
          >
            <X size="0.875rem" />
          </button>
        </div>
        {lsp.servers.map((s) => (
          <ServerStatus key={s.command} server={s} />
        ))}
        {!lsp.servers.length && !lsp.missing.length && <p className="text-muted">No servers</p>}
        {lsp.missing.map((m) => (
          <div
            className="mt-3 flex items-center gap-2 border-t border-border pt-3 text-muted"
            key={m.language}
            title={m.tried.join(', ')}
          >
            <CircleOff size="0.875rem" className="shrink-0" />
            <span className="min-w-0 flex-1 font-medium wrap-anywhere text-foreground">{m.language}</span>
            <span className="shrink-0 text-[0.6875rem]">{m.tried.length ? 'Not on PATH' : 'Disabled'}</span>
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
    <div className="mt-3 border-t border-border pt-3">
      <div className="flex items-center gap-2">
        {busy ? (
          <LoaderCircle size="0.875rem" className="shrink-0 animate-spin text-accent" />
        ) : problem ? (
          <CircleAlert size="0.875rem" className="shrink-0 text-warn" />
        ) : (
          <Check size="0.875rem" className="shrink-0 text-add" />
        )}
        <strong className="min-w-0 flex-1 font-medium wrap-anywhere">{s.name}</strong>
        <span
          className="shrink-0 text-[0.6875rem] text-muted"
          title={label === 'Connected' ? 'Initialized; workspace readiness is not reported by LSP' : undefined}
        >
          {label}
        </span>
      </div>
      <div className="mt-1 mb-1.5 ml-5.5 text-[0.6875rem] text-muted">{s.languages.join(', ')}</div>
      {s.activity?.map((activity, i) => (
        <p className="my-1.5 ml-5.5 wrap-anywhere" key={i}>
          {activity}
        </p>
      ))}
      {s.message && <p className="my-1.5 ml-5.5 wrap-anywhere text-warn">{s.message}</p>}
      {s.notice && <p className="my-1.5 ml-5.5 wrap-anywhere text-warn">{s.notice.message}</p>}
      <details className="ml-5.5 text-[0.6875rem] text-muted [&_pre]:my-2 [&_pre]:font-mono [&_pre]:wrap-anywhere [&_pre]:whitespace-pre-wrap">
        <summary className="cursor-pointer">Details</summary>
        <pre>{s.command}</pre>
        {s.stderr && (
          <>
            <span>stderr</span>
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
