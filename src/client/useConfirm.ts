import { useEffect, useState } from 'react';

/**
 * Two-click guard for destructive buttons. The first `fire` arms the button
 * for `ms`; a second `fire` while armed runs `action` and disarms. Render
 * `armed` as the `confirm` class plus a "…?" label so the reader sees the arm.
 */
export function useConfirm(action: () => void, ms = 3000): { armed: boolean; fire: () => void } {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), ms);
    return () => clearTimeout(t);
  }, [armed, ms]);
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
