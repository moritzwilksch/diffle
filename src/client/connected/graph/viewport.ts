import type { Point } from './layout.js';

/** The content group's placement: translate by (x, y), then scale by k. */
export interface Transform {
  x: number;
  y: number;
  k: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MIN_SCALE = 0.15;
export const MAX_SCALE = 3;
/** A tiny graph is not blown up past this when fitted. */
export const FIT_MAX_SCALE = 1.25;
export const FIT_MARGIN = 24;
/** Scale factor of one zoom button press or key. */
export const ZOOM_STEP = 1.25;

const WHEEL_ZOOM = 0.0015;
const WHEEL_LINE_PX = 16;

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** The zoom factor of a wheel notch; `deltaMode` 1 reports lines, not pixels. */
export function wheelFactor(deltaY: number, deltaMode: number): number {
  return Math.exp(-(deltaMode === 1 ? deltaY * WHEEL_LINE_PX : deltaY) * WHEEL_ZOOM);
}

export function clampScale(k: number): number {
  return clamp(k, MIN_SCALE, MAX_SCALE);
}

/** Centres `content` in `viewport` inside `margin`, at the largest scale up to `maxScale`. */
export function fitTransform(content: Size, viewport: Size, margin = FIT_MARGIN, maxScale = FIT_MAX_SCALE): Transform {
  const fits = (box: number, room: number): number => (box > 0 ? Math.max(0, room - 2 * margin) / box : Infinity);
  const k = clampScale(Math.min(maxScale, fits(content.width, viewport.width), fits(content.height, viewport.height)));
  return { x: (viewport.width - content.width * k) / 2, y: (viewport.height - content.height * k) / 2, k };
}

/** Scales by `factor` around `point` (viewport pixels); the content under it stays put. Same object at a bound. */
export function zoomAt(t: Transform, factor: number, point: Point): Transform {
  const k = clampScale(t.k * factor);
  if (k === t.k) return t;
  const r = k / t.k;
  return { x: point.x - (point.x - t.x) * r, y: point.y - (point.y - t.y) * r, k };
}

/** Pans just enough to bring `rect` (content coordinates) inside the viewport; the left/top edge wins. */
export function panIntoView(t: Transform, rect: Rect, viewport: Size, pad: number): Transform {
  const axis = (pos: number, size: number, room: number): number => {
    let d = 0;
    if (pos + size > room - pad) d = room - pad - (pos + size);
    if (pos + d < pad) d = pad - pos;
    return d;
  };
  const dx = axis(rect.x * t.k + t.x, rect.w * t.k, viewport.width);
  const dy = axis(rect.y * t.k + t.y, rect.h * t.k, viewport.height);
  return dx === 0 && dy === 0 ? t : { ...t, x: t.x + dx, y: t.y + dy };
}
