import { SegmentedControl, ToggleButton } from '@/client/ui/ToggleButton.js';
import { Button } from '@/client/ui/Button.js';
import {
  Columns2,
  GitCompareArrows,
  Keyboard,
  Monitor,
  Moon,
  PanelLeft,
  PanelRight,
  Rows3,
  Settings,
  Sun,
} from 'lucide-react';
import { useState } from 'react';
import { repoName } from '@/client/model.js';
import { useStore } from '@/client/store.js';
import { nextTheme, type ThemeChoice } from '@/client/theme.js';
import { CommitStepper } from './CommitStepper.js';
import { GithubMenu } from './GithubMenu.js';
import { HistoryNav } from './HistoryNav.js';
import { LspIndicator } from './LspStatus.js';
import { ModePicker } from './ModePicker.js';
import { MovedNotice } from './MovedNotice.js';
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
      <HistoryNav />
      <span className="inline-flex items-center gap-1.5 font-bold tracking-[0.02em] max-sm:hidden">
        <GitCompareArrows size="1rem" /> <span className="max-lg:hidden">diffle</span>
      </span>
      <span className="truncate font-mono text-[0.75rem] text-muted max-lg:hidden" title={snapshot?.root}>
        {snapshot ? repoName(snapshot) : ''}
      </span>
      <ModePicker />
      <CommitStepper />
      {snapshot?.commit && (
        <span
          className="max-w-[24rem] min-w-0 shrink-[100] truncate text-[0.8125rem] max-md:hidden"
          title={snapshot.commit.message}
        >
          {snapshot.commit.message.split('\n', 1)[0]}
        </span>
      )}
      <GithubMenu />
      <MovedNotice />
      <span className="shrink-0 whitespace-nowrap text-muted max-md:hidden">
        {changed} files · <span className="text-add">+{adds}</span> <span className="text-del">−{dels}</span>
      </span>
      <span className="flex-1" />
      {lsp.enabled && <LspIndicator lsp={lsp} />}
      <SegmentedControl title="Diff layout (s)">
        <ToggleButton selected={diffStyle === 'split'} onClick={() => setDiffStyle('split')} aria-label="Split">
          <Columns2 size="0.875rem" /> <span className="max-xl:hidden">Split</span>
        </ToggleButton>
        <ToggleButton selected={diffStyle === 'unified'} onClick={() => setDiffStyle('unified')} aria-label="Unified">
          <Rows3 size="0.875rem" /> <span className="max-xl:hidden">Unified</span>
        </ToggleButton>
      </SegmentedControl>
      <Button variant="ghost" icon onClick={() => setTheme(nextTheme(theme))} title={`Theme: ${theme} (t)`}>
        <ThemeIcon choice={theme} />
      </Button>
      <Button variant="ghost" icon onClick={() => useStore.getState().setHelpOpen(true)} title="Keyboard shortcuts (?)">
        <Keyboard size="1rem" />
      </Button>
      <Button variant="ghost" onClick={() => setSettingsOpen(true)} title="Settings" aria-label="Settings">
        <Settings size="0.9375rem" /> <span className="max-xl:hidden">Settings</span>
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

function ThemeIcon({ choice }: { choice: ThemeChoice }) {
  if (choice === 'light') return <Sun size="1rem" />;
  if (choice === 'dark') return <Moon size="1rem" />;
  return <Monitor size="1rem" />;
}
