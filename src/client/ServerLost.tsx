import { Unplug } from 'lucide-react';

/**
 * Shown while the socket to the diffle server is down, typically because the process was
 * stopped: every fetch, LSP query included, would fail, so say so instead of failing silently.
 * The socket keeps retrying; a restarted server resyncs the page and hides this.
 */
export function ServerLost() {
  return (
    <div
      role="alert"
      className="fixed top-12 left-[50%] z-60 flex max-w-[min(48rem,_90vw)] [transform:translateX(-50%)] [animation:flash-in_160ms_ease] items-center gap-3 rounded-lg border border-danger bg-raised px-4 py-2.5 text-[0.875rem] leading-[1.4] text-foreground shadow-[0_0.5rem_1.5rem_rgba(0,_0,_0,_0.35)]"
    >
      <Unplug size="1rem" className="shrink-0 text-danger" />
      <span>
        Lost the connection to the diffle server. Restart <code className="font-mono">diffle</code> to keep reviewing;
        this page reconnects on its own.
      </span>
    </div>
  );
}
