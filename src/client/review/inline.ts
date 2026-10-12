import { remPx } from '../scale.js';
import { overflow } from './geometry.js';

/** Room kept between a revealed target and the edges of its code column, in rem. */
const MARGIN_REM = 2;

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
  if (delta) code.scrollLeft += delta;
}

/** Scrolls a code column sideways by `fraction` of the width its line numbers leave visible. */
export function scrollInline(code: HTMLElement, fraction: number): void {
  const view = visible(code);
  code.scrollLeft += Math.round((view.right - view.left) * fraction);
}

/** The column's visible text area: right of its sticky gutter. */
function visible(code: HTMLElement): { left: number; right: number } {
  const box = code.getBoundingClientRect();
  const gutter = code.querySelector(':scope > [data-gutter]')?.getBoundingClientRect();
  return { left: gutter ? gutter.right : box.left, right: box.left + code.clientWidth };
}
