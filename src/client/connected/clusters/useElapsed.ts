import { useEffect, useState } from 'react';

const TICK_MS = 1000;

/** Milliseconds since `running` last became true, refreshed every second; 0 while it is false. */
export function useElapsed(running: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) return;
    const start = Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - start), TICK_MS);
    return () => {
      clearInterval(timer);
      setElapsed(0);
    };
  }, [running]);
  return elapsed;
}
