/**
 * Root font size in CSS px. Every size in the client is in rem, so `html { font-size }`
 * in styles.css is the one knob that scales the whole app; layout math that must agree
 * with the stylesheet (row heights, the sticky header, pane widths) multiplies by this.
 * 16 outside a browser, so pure store code can run in node tests.
 */
export function remPx(): number {
  if (typeof document === 'undefined') return 16;
  const n = parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(n) && n > 0 ? n : 16;
}
