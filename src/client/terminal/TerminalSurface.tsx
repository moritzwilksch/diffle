import { useEffect, useRef, useState } from 'react';
import type { Terminal } from 'ghostty-web';
import { connectTerminal } from '@/client/api.js';
import { useRemPx } from '@/client/scale.js';
import { useStore } from '@/client/store.js';
import { TerminalReplaySchema, TerminalResizeSchema, TerminalStatusSchema } from '@/shared/protocol.js';
import { loadTerminalFonts, terminalFont, terminalPalette } from './appearance.js';
import { terminalLayoutSaved } from './state.js';

const loadGhostty = async () => {
  const [lib, { default: wasmUrl }] = await Promise.all([
    import('ghostty-web'),
    import('ghostty-web/ghostty-vt.wasm?url'),
  ]);
  const ghostty = await lib.Ghostty.load(wasmUrl);
  return { lib, ghostty };
};
let loading: ReturnType<typeof loadGhostty> | undefined;

export function TerminalSurface({
  token,
  pane,
  active,
  focusRequest,
}: {
  token: string;
  pane: number;
  active: boolean;
  focusRequest: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal>(null);
  const resizeTerminal = useRef<() => void>(null);
  const fontSize = useStore((s) => s.config.terminalFontSize);
  const rem = useRemPx();
  const savedSize = useRef(fontSize);
  const focused = useRef(active);
  const [status, setStatus] = useState('Starting shell…');

  useEffect(() => {
    savedSize.current = fontSize;
    resizeTerminal.current?.();
  }, [fontSize, rem]);

  useEffect(() => {
    const host = container.current;
    if (!host) return;
    let cancelled = false;
    let cleanup: (() => void) | undefined;

    async function start(host: HTMLDivElement) {
      loading ??= loadGhostty().catch((error: unknown) => {
        loading = undefined;
        throw error;
      });
      const [{ lib, ghostty }] = await Promise.all([loading, loadTerminalFonts()]);
      await terminalLayoutSaved();
      if (cancelled) return;
      const size = () => savedSize.current ?? Number.parseFloat(getComputedStyle(host).fontSize);
      const term = new lib.Terminal({
        ghostty,
        fontFamily: terminalFont,
        fontSize: size(),
        cursorBlink: true,
        cursorStyle: 'bar',
        scrollback: 5000,
        theme: terminalPalette(),
      });
      const fit = new lib.FitAddon();
      term.loadAddon(fit);
      // Ghostty queues focus on open. Let the socket handler focus the active pane.
      const focus = term.focus;
      term.focus = () => {};
      try {
        term.open(host);
      } finally {
        term.focus = focus;
      }
      terminal.current = term;
      let ws: WebSocket | undefined;
      let reconnect: ReturnType<typeof setTimeout> | undefined;
      let reconnectDelay = 250;
      let opened = false;
      let exited = false;
      let replayChunks = 0;
      let replaying = false;
      const paste = (event: ClipboardEvent) => {
        const text = event.clipboardData?.getData('text/plain');
        if (!text) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        // Ghostty's DOM paste handler sends raw text. Its API honors bracketed paste mode.
        term.paste(text);
      };
      host.addEventListener('paste', paste, true);
      cleanup = () => {
        host.removeEventListener('paste', paste, true);
        clearTimeout(reconnect);
        ws?.close();
        terminal.current = null;
        term.dispose();
      };
      const resize = () => {
        if (host.clientHeight === 0) return;
        term.options.fontSize = size();
        const dims = fit.proposeDimensions();
        if (!dims) return;
        term.resize(Math.min(500, dims.cols), Math.min(300, dims.rows));
      };
      resizeTerminal.current = resize;
      const observer = new ResizeObserver(resize);
      observer.observe(host);
      resize();
      const dispose = cleanup;
      cleanup = () => {
        resizeTerminal.current = null;
        observer.disconnect();
        dispose();
      };
      const sendSize = () => {
        if (ws?.readyState !== WebSocket.OPEN) return;
        const size = TerminalResizeSchema.parse({ cols: term.cols, rows: term.rows });
        ws.send(JSON.stringify(size));
      };
      term.onResize(sendSize);
      const encoder = new TextEncoder();
      term.onData((data) => {
        if (replaying || exited || ws?.readyState !== WebSocket.OPEN) return;
        const bytes = encoder.encode(data);
        for (let offset = 0; offset < bytes.length; offset += 32 * 1024) {
          ws.send(bytes.subarray(offset, offset + 32 * 1024));
        }
      });
      const attach = () => {
        const socket = connectTerminal(token, pane);
        ws = socket;
        socket.onopen = () => {
          replayChunks = 0;
          if (opened) term.reset();
          opened = true;
          sendSize();
          if (focused.current && host.offsetParent !== null && !host.closest('[inert]'))
            host.focus({ preventScroll: true });
          setStatus('');
        };
        socket.onmessage = ({ data }: MessageEvent<unknown>) => {
          if (data instanceof ArrayBuffer) {
            reconnectDelay = 250;
            replaying = replayChunks > 0;
            try {
              term.write(new Uint8Array(data));
            } finally {
              replayChunks = Math.max(0, replayChunks - 1);
              replaying = false;
            }
          } else if (typeof data === 'string') {
            const message: unknown = JSON.parse(data);
            const replay = TerminalReplaySchema.safeParse(message);
            if (replay.success) {
              replayChunks = replay.data.replayChunks;
              return;
            }
            exited = true;
            const result = TerminalStatusSchema.parse(message);
            setStatus(result.error ?? `Shell exited${result.exitCode == null ? '' : ` (${result.exitCode})`}`);
          }
        };
        socket.onclose = (event) => {
          if (cancelled || exited) return;
          if (event.code === 1008) {
            setStatus(event.reason || 'Terminal closed');
            return;
          }
          setStatus('Reconnecting…');
          reconnect = setTimeout(attach, reconnectDelay);
          reconnectDelay = Math.min(5000, reconnectDelay * 2);
        };
      };
      attach();
    }

    void start(host).catch((error: unknown) => {
      if (!cancelled) setStatus(error instanceof Error ? error.message : String(error));
    });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [token, pane]);

  useEffect(() => {
    focused.current = active;
    if (active && terminal.current) container.current?.focus({ preventScroll: true });
  }, [active, focusRequest]);

  return (
    <div className="relative min-h-0 flex-1" data-terminal-input>
      <div ref={container} className="absolute inset-0 bg-canvas p-2 text-sm text-foreground" />
      {status && (
        <span className="pointer-events-none absolute right-3 bottom-2 rounded-md border border-border bg-card px-2 py-1 text-xs text-muted shadow-sm">
          {status}
        </span>
      )}
    </div>
  );
}
