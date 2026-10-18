import { remPx } from '@/client/scale.js';
import { overflow } from './geometry.js';

/** Room kept between a revealed target and the edges of its code column, in rem. */
const MARGIN_REM = 2;

/** One wheel notch in line mode (Firefox mice), in rem. */
const WHEEL_LINE_REM = 1.25;

/**
 * Scrolls the code column holding `target` sideways by the least amount that shows it beside the
 * sticky line numbers. A no-op while lines wrap, since nothing overflows then.
 */
export function revealInline(target: Range | Element): void {
  const node = 'startContainer' in target ? target.startContainer : target;
  const code = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('[data-code]');
  if (!code || code.scrollWidth <= code.clientWidth) return;
  const view = visible(code);
  const box = target.getBoundingClientRect();
  const margin = MARGIN_REM * remPx();
  // The horizontal axis through the vertical helper: left/right stand in for top/bottom.
  const delta = overflow(
    { top: view.left, bottom: view.right },
    { top: box.left - margin, bottom: box.right + margin },
  );
  if (delta) scrollColumns(code, code.scrollLeft + delta);
}

/** Scrolls a code column sideways by `fraction` of the width its line numbers leave visible. */
export function scrollInline(code: HTMLElement, fraction: number): void {
  const view = visible(code);
  scrollColumns(code, code.scrollLeft + Math.round((view.right - view.left) * fraction));
}

/**
 * Moves horizontal wheel gestures over a split diff onto both of its columns at once. The viewer
 * mirrors one column's scroll onto the other from a scroll listener, which runs a frame after the
 * browser has already moved the first column, so a trackpad swipe showed the two sides drifting
 * apart. Vertical gestures, pinches, and wrapped or short lines stay with the browser. Returns the
 * teardown.
 */
export function installInlineWheel(scroller: HTMLElement): () => void {
  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey) return;
    const code = e
      .composedPath()
      .find((n): n is HTMLElement => n instanceof HTMLElement && n.hasAttribute('data-code'));
    if (!code || siblingsOf(code).length === 0 || code.scrollWidth <= code.clientWidth) return;
    // Shift turns a plain wheel sideways where the browser has not done so already.
    const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
    if (dx === 0 || (!e.shiftKey && Math.abs(dx) < Math.abs(e.deltaY))) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? WHEEL_LINE_REM * remPx() : e.deltaMode === 2 ? code.clientWidth : 1;
    scrollColumns(code, code.scrollLeft + dx * unit);
  };
  scroller.addEventListener('wheel', onWheel, { passive: false });
  return () => scroller.removeEventListener('wheel', onWheel);
}

/**
 * Scrolls `code` to `left` and, in a split diff, the other column to the same place in the same
 * frame. `code` goes first and the others follow its settled position, so the column the reader
 * addresses leads where the two differ in width; the viewer's own mirroring then has nothing left to do.
 */
function scrollColumns(code: HTMLElement, left: number): void {
  code.scrollLeft = left;
  for (const other of siblingsOf(code)) other.scrollLeft = code.scrollLeft;
}

/** The other code columns of `code`'s diff: one in a split layout, none in a unified one. */
function siblingsOf(code: HTMLElement): HTMLElement[] {
  const columns = code.parentElement?.querySelectorAll<HTMLElement>(':scope > [data-code]') ?? [];
  return [...columns].filter((c) => c !== code);
}

/** The column's visible text area: right of its sticky gutter. */
function visible(code: HTMLElement): { left: number; right: number } {
  const box = code.getBoundingClientRect();
  const gutter = code.querySelector(':scope > [data-gutter]')?.getBoundingClientRect();
  return { left: gutter ? gutter.right : box.left, right: box.left + code.clientWidth };
}
