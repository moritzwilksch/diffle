interface ClientCounter {
  onClientsChanged(listener: (count: number) => void): () => void;
}

/**
 * Ends an auto-opened review after its last browser client stays gone. The
 * grace period lets a reload replace its WebSocket without ending the review.
 */
export function watchBrowserLifetime(
  clients: ClientCounter,
  enabled: boolean,
  onClose: () => void,
  graceMs = 1000,
): () => void {
  if (!enabled) return () => {};

  let connected = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = clients.onClientsChanged((count) => {
    if (count > 0) {
      connected = true;
      clearTimeout(timer);
      timer = undefined;
    } else if (connected && !timer) {
      timer = setTimeout(onClose, graceMs);
      timer.unref?.();
    }
  });

  return () => {
    unsubscribe();
    clearTimeout(timer);
  };
}
