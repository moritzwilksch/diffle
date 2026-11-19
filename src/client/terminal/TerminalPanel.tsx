import { ChevronDown, Columns2, Plus, Terminal, X } from 'lucide-react';
import { useEffect, useState, type PointerEvent } from 'react';
import { api } from '@/client/api.js';
import { Button } from '@/client/ui/Button.js';
import {
  addTerminal,
  closeTerminal,
  closeTerminalPane,
  configureTerminals,
  hasTerminalRoom,
  selectTerminal,
  selectTerminalPane,
  splitTerminal,
  toggleTerminal,
  useTerminalLayout,
} from './state.js';
import { TerminalSurface } from './TerminalSurface.js';

export function TerminalToggle() {
  const token = useTerminalLayout((s) => s.token);
  const open = useTerminalLayout((s) => s.open);

  useEffect(() => {
    const controller = new AbortController();
    void api.terminalAccess(controller.signal).then(
      (access) => {
        if (!controller.signal.aborted) configureTerminals(access);
      },
      () => {},
    );
    return () => controller.abort();
  }, []);

  if (!token) return null;
  return (
    <Button
      variant="ghost"
      icon
      data-terminal-toggle
      aria-label="Terminal"
      aria-expanded={open}
      aria-controls="terminal-panel"
      title="Toggle terminal (Ctrl+`)"
      onClick={toggleTerminal}
    >
      <Terminal size="1rem" />
    </Button>
  );
}

function clampHeight(height: number): number {
  return Math.min(Math.max(120, height), Math.round(window.innerHeight * 0.75));
}

export function TerminalPanel() {
  const { token, tabs, open, active, focusRequest } = useTerminalLayout();
  const [height, setHeight] = useState(264);
  if (!token || (!open && !tabs.length)) return null;
  const room = hasTerminalRoom(tabs);
  const activeTab = tabs.find((tab) => tab.id === active);

  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const resize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      setHeight(clampHeight(window.innerHeight - event.clientY));
  };

  return (
    <section
      id="terminal-panel"
      aria-label="Terminal panel"
      className={open ? 'col-span-full flex min-h-0 flex-col border-t border-border bg-canvas' : 'hidden'}
      style={{ height: `min(${height}px, 75vh)` }}
    >
      <div
        className="group flex h-1.5 shrink-0 cursor-row-resize items-center justify-center bg-surface"
        onPointerDown={startResize}
        onPointerMove={resize}
      >
        <span className="h-0.5 w-8 rounded-full bg-border group-hover:bg-accent" />
      </div>
      <div className="flex shrink-0 items-center gap-1 border-b border-border bg-surface px-2 pb-1.5 text-xs">
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
          {tabs.map(({ id }) => (
            <div
              key={id}
              data-active={id === active}
              className="flex shrink-0 items-center rounded-md border border-transparent text-muted data-[active=true]:border-border data-[active=true]:bg-card data-[active=true]:text-foreground"
            >
              <Button variant="ghost" aria-pressed={id === active} onClick={() => selectTerminal(id)}>
                <Terminal size="0.8125rem" />
                Terminal {id}
              </Button>
              <Button variant="ghost" icon aria-label={`Close terminal ${id}`} onClick={() => closeTerminal(id)}>
                <X size="0.8rem" />
              </Button>
            </div>
          ))}
        </div>
        <Button variant="ghost" icon aria-label="New terminal" disabled={!room} onClick={addTerminal}>
          <Plus size="1rem" />
        </Button>
        <Button
          variant="ghost"
          icon
          aria-label="Split terminal right"
          disabled={!activeTab || !room}
          onClick={splitTerminal}
        >
          <Columns2 size="1rem" />
        </Button>
        {(activeTab?.panes.length ?? 0) > 1 && (
          <Button variant="ghost" icon aria-label="Close active terminal pane" onClick={closeTerminalPane}>
            <X size="0.8rem" />
          </Button>
        )}
        <span className="flex-1" />
        <Button variant="ghost" icon aria-label="Hide terminal panel" onClick={toggleTerminal}>
          <ChevronDown size="1rem" />
        </Button>
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={tab.id === active ? 'flex min-h-0 flex-1 divide-x divide-border' : 'hidden'}
          inert={!open || tab.id !== active}
        >
          {tab.panes.map((pane) => {
            const focused = open && tab.id === active && tab.activePane === pane;
            return (
              <div
                key={pane}
                className="relative flex min-w-0 flex-1 overflow-hidden"
                onFocusCapture={() => selectTerminalPane(pane)}
                data-terminal-pane={pane}
              >
                <TerminalSurface token={token} pane={pane} active={focused} focusRequest={focusRequest} />
                {tab.panes.length > 1 && focused && (
                  <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-px bg-accent" />
                )}
              </div>
            );
          })}
        </div>
      ))}
    </section>
  );
}
