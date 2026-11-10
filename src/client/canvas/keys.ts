import type { CanvasControl } from './viewport.js';

const ZOOM_STEP = 1.25;

/** The keys every canvas takes: `0` fits, `+` and `-` zoom. True when `e` was one. */
export function canvasKeys(e: KeyboardEvent, control: CanvasControl): boolean {
  switch (e.key) {
    case '0':
      control.fit();
      return true;
    case '+':
    case '=':
      control.zoom(ZOOM_STEP);
      return true;
    case '-':
      control.zoom(1 / ZOOM_STEP);
      return true;
    default:
      return false;
  }
}
