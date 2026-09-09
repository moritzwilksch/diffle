import { useEffect, useState } from 'react';

/**
 * Two-click guard for destructive buttons. The first `fire` arms the button
 * for three seconds; a second `fire` while armed runs `action` and disarms.
 * Render `armed` as the `confirm` class plus a "…?" label so the reader sees the arm.
 */
export function useConfirm(action: () => void): { armed: boolean; fire: () => void } {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return {
    armed,
    fire: () => {
      if (!armed) {
        setArmed(true);
        return;
      }
      setArmed(false);
      action();
    },
  };
}
