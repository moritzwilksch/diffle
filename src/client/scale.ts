import { useSyncExternalStore } from 'react';

let applied = 100;
let rem: number | null = null;
const beforeChange = new Set<() => void>();
const afterChange = new Set<() => void>();

/**
 * Root font size in CSS px. `html { font-size }` scales the interface's rem units;
 * layout math that must agree
 * with the stylesheet (row heights, the sticky header, pane widths) multiplies by this.
 * 16 outside a browser, so pure store code can run in node tests.
 */
export function remPx(): number {
  if (typeof document === 'undefined') return 16;
  // Cached: components read it on every render, and a computed style forces a style recalculation.
  if (rem === null) {
    const n = parseFloat(getComputedStyle(document.documentElement).fontSize);
    rem = Number.isFinite(n) && n > 0 ? n : 16;
  }
  return rem;
}

/** `remPx()` that re-renders its component when the text size changes. */
export function useRemPx(): number {
  return useSyncExternalStore(
    (onChange) => {
      afterChange.add(onChange);
      return () => afterChange.delete(onChange);
    },
    remPx,
    () => 16,
  );
}

/** Calls `listener` just before the text size changes, while the old layout can still be measured. */
export function onTextSizeChange(listener: () => void): () => void {
  beforeChange.add(listener);
  return () => beforeChange.delete(listener);
}

/** Scales the root font size (`html` in `styles/base.css`); a no-op when `size` is already applied. */
export function applyTextSize(size: number): void {
  if (size === applied) return;
  for (const listener of beforeChange) listener();
  applied = size;
  document.documentElement.style.setProperty('--diffle-text-scale', String(size / 100));
  rem = null;
  for (const notify of afterChange) notify();
}
