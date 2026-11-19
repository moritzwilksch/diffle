import { create } from 'zustand';
import { api } from '@/client/api.js';
import { MAX_TERMINALS, type TerminalAccess, type TerminalLayout } from '@/shared/protocol.js';

interface LayoutState extends Omit<TerminalLayout, 'updatedAt'> {
  token?: string;
  focusRequest: number;
}

export const useTerminalLayout = create<LayoutState>(() => ({
  open: false,
  next: 1,
  active: null,
  tabs: [],
  focusRequest: 0,
}));

let stamp = 0;
let saved = Promise.resolve();

export function configureTerminals({ token, layout }: TerminalAccess): void {
  if (useTerminalLayout.getState().token === token) return;
  const { updatedAt, ...rest } = layout;
  stamp = updatedAt;
  saved = Promise.resolve();
  useTerminalLayout.setState({ token, ...rest });
}

useTerminalLayout.subscribe(({ token, open, next, active, tabs }, prev) => {
  if (!token || token !== prev.token) return;
  if (open === prev.open && next === prev.next && active === prev.active && tabs === prev.tabs) return;
  stamp = Math.max(stamp + 1, Math.floor((performance.timeOrigin + performance.now()) * 1000));
  saved = api.saveTerminalLayout(token, { open, next, active, tabs, updatedAt: stamp });
  void saved.catch(() => {});
});

/** A newly rendered pane can attach once its ID is part of the server layout. */
export function terminalLayoutSaved(): Promise<void> {
  return saved;
}

export function hasTerminalRoom(tabs: TerminalLayout['tabs']): boolean {
  return tabs.reduce((count, tab) => count + tab.panes.length, 0) < MAX_TERMINALS;
}

export function addTerminal(): void {
  useTerminalLayout.setState((s) =>
    hasTerminalRoom(s.tabs)
      ? { next: s.next + 1, tabs: [...s.tabs, { id: s.next, panes: [s.next], activePane: s.next }], active: s.next }
      : s,
  );
}

export function selectTerminal(id: number): void {
  useTerminalLayout.setState((s) => ({ active: id, focusRequest: s.focusRequest + 1 }));
}

export function closeTerminal(id: number): void {
  useTerminalLayout.setState(({ active, tabs }) => {
    const index = tabs.findIndex((tab) => tab.id === id);
    const remaining = tabs.filter((tab) => tab.id !== id);
    return { tabs: remaining, active: id === active ? ((remaining[index] ?? remaining.at(-1))?.id ?? null) : active };
  });
}

export function splitTerminal(): void {
  useTerminalLayout.setState((s) => {
    if (!hasTerminalRoom(s.tabs)) return s;
    return {
      next: s.next + 1,
      tabs: s.tabs.map((tab) => {
        if (tab.id !== s.active) return tab;
        const at = tab.panes.indexOf(tab.activePane) + 1;
        const panes = [...tab.panes];
        panes.splice(at, 0, s.next);
        return { ...tab, panes, activePane: s.next };
      }),
    };
  });
}

export function closeTerminalPane(): void {
  useTerminalLayout.setState((s) => ({
    tabs: s.tabs.map((tab) => {
      if (tab.id !== s.active || tab.panes.length < 2) return tab;
      const at = tab.panes.indexOf(tab.activePane);
      const panes = tab.panes.filter((pane) => pane !== tab.activePane);
      return { ...tab, panes, activePane: (panes[at] ?? panes.at(-1))! };
    }),
  }));
}

export function selectTerminalPane(id: number): void {
  useTerminalLayout.setState((s) => {
    const tab = s.tabs.find((tab) => tab.id === s.active);
    if (!tab || tab.activePane === id || !tab.panes.includes(id)) return s;
    return { tabs: s.tabs.map((entry) => (entry === tab ? { ...tab, activePane: id } : entry)) };
  });
}

function focusCurrentTerminal(): void {
  if (useTerminalLayout.getState().tabs.length === 0) addTerminal();
  useTerminalLayout.setState((s) => ({ open: true, focusRequest: s.focusRequest + 1 }));
}

export function moveTerminalFocus(code: string): boolean {
  const { token, tabs, active, open, focusRequest } = useTerminalLayout.getState();
  if (code === 'KeyG' && token) {
    focusCurrentTerminal();
    return true;
  }
  if (!open) return false;
  const index = tabs.findIndex((tab) => tab.id === active);
  const tab = tabs[index];
  if (!tab) return false;
  if (code === 'KeyJ' || code === 'KeyK') {
    selectTerminal(tabs[(index + (code === 'KeyJ' ? 1 : -1) + tabs.length) % tabs.length]!.id);
    return true;
  }
  if (code === 'KeyH' || code === 'KeyL') {
    const current = tab.panes.indexOf(tab.activePane);
    const neighbor = tab.panes[current + (code === 'KeyL' ? 1 : -1)];
    if (neighbor) selectTerminalPane(neighbor);
    useTerminalLayout.setState({ focusRequest: focusRequest + 1 });
    return true;
  }
  return false;
}

export function toggleTerminal(): void {
  const { token, open } = useTerminalLayout.getState();
  if (!token) return;
  if (!open) {
    focusCurrentTerminal();
    return;
  }
  useTerminalLayout.setState({ open: false });
  document.querySelector<HTMLButtonElement>('[data-terminal-toggle]')?.focus();
}
