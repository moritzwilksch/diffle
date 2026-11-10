import { type PointerEvent, type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import type { Box } from './layout/layout.js';

/** Where the canvas shows its content: shifted by `x`, `y` and scaled by `k`. */
export interface View {
  x: number;
  y: number;
  k: number;
  /** Glide to this view: a fit or a focus does, a drag or the wheel follows the pointer at once. */
  ease?: boolean;
}

/** A press on the canvas: where the pointer is now, whether it dragged, and what it first landed on. */
export interface Press {
  x: number;
  y: number;
  moved: boolean;
  target: Element;
}

/** What a view's keys and side panel do to its mounted canvas. */
export interface CanvasControl {
  fit: () => void;
  /** Zooms about the canvas's centre. */
  zoom: (factor: number) => void;
}

export interface Viewport {
  host: RefObject<HTMLDivElement | null>;
  view: View;
  /** The last press, kept after release: pointer capture retargets the click to the host. */
  press: RefObject<Press | null>;
  /** Glides to show `box` whole, at most at `maxZoom`. */
  fitBox: (box: Box, maxZoom: number) => void;
  zoomAt: (px: number, py: number, factor: number, ease?: boolean) => void;
  /** Glides `box` to the centre when any of it is out of sight, at the zoom it has. */
  reveal: (box: Box) => void;
  /** Drag to pan. */
  pointer: {
    onPointerDown: (e: PointerEvent) => void;
    onPointerMove: (e: PointerEvent) => void;
    onPointerUp: () => void;
  };
}

export const EASE_MS = 200;
const MARGIN = 48;
const MAX_ZOOM = 3;
const MIN_ZOOM = 0.15;
/** Pixels per line, for wheels that scroll by lines. */
const LINE_PX = 16;

/**
 * Pans by dragging and by two-finger scrolling, zooms by a pinch (a wheel with Ctrl, as browsers
 * report it), and fits or reveals boxes with a glide.
 */
export function useViewport(): Viewport {
  const host = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const drag = useRef<Press | null>(null);
  const press = useRef<Press | null>(null);

  // Each reads only refs and the state setter, so one set serves every render and effects can depend on it.
  const moves = useMemo(() => {
    const fitBox = (box: Box, maxZoom: number) => {
      const el = host.current;
      if (!el || !el.clientWidth) return;
      const [w, h] = [box.w + 2 * MARGIN, box.h + 2 * MARGIN];
      const k = Math.min(maxZoom, el.clientWidth / w, el.clientHeight / h);
      setView({
        k,
        x: (el.clientWidth - w * k) / 2 + (MARGIN - box.x) * k,
        y: (el.clientHeight - h * k) / 2 + (MARGIN - box.y) * k,
        ease: true,
      });
    };
    const zoomAt = (px: number, py: number, factor: number, ease = false) =>
      setView((v) => {
        const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * factor));
        return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k, ease };
      });
    const reveal = (p: Box) => {
      const el = host.current;
      if (!el) return;
      setView((v) => {
        const [left, top] = [p.x * v.k + v.x, p.y * v.k + v.y];
        const inside =
          left >= 0 && top >= 0 && left + p.w * v.k <= el.clientWidth && top + p.h * v.k <= el.clientHeight;
        if (inside) return v;
        const [x, y] = [el.clientWidth / 2 - (p.x + p.w / 2) * v.k, el.clientHeight / 2 - (p.y + p.h / 2) * v.k];
        return { ...v, x, y, ease: true };
      });
    };
    return { fitBox, zoomAt, reveal };
  }, []);
  const { zoomAt } = moves;

  // React's wheel listeners are passive and cannot stop the page from scrolling along; this one can.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const onWheel = (e: globalThis.WheelEvent) => {
      e.preventDefault();
      const unit =
        e.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? LINE_PX
          : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? el.clientHeight
            : 1;
      const [dx, dy] = [e.deltaX * unit, e.deltaY * unit];
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-Math.max(-50, Math.min(50, dy)) * 0.01));
      } else setView((v) => ({ ...v, x: v.x - dx, y: v.y - dy, ease: false }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  const pointer = {
    onPointerDown: (e: PointerEvent) => {
      drag.current = press.current = { x: e.clientX, y: e.clientY, moved: false, target: e.target as Element };
      host.current!.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const [dx, dy] = [e.clientX - d.x, e.clientY - d.y];
      if (!d.moved && Math.hypot(dx, dy) < 3) return;
      drag.current = press.current = { ...d, x: e.clientX, y: e.clientY, moved: true };
      setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy, ease: false }));
    },
    onPointerUp: () => {
      drag.current = null;
    },
  };
  return { host, view, press, ...moves, pointer };
}

/** Zooms `viewport` about its centre, with a glide. */
export function zoomCentre(viewport: Viewport, factor: number): void {
  const el = viewport.host.current;
  if (el) viewport.zoomAt(el.clientWidth / 2, el.clientHeight / 2, factor, true);
}

/** The value of `attr` on `target` or its nearest ancestor that has it. */
export function attrOf(target: EventTarget | undefined, attr: string): string | null {
  return target instanceof Element ? (target.closest(`[${attr}]`)?.getAttribute(attr) ?? null) : null;
}

/** The box around `boxes`. */
export function bounds(boxes: Box[]): Box {
  const [x, y] = [Math.min(...boxes.map((b) => b.x)), Math.min(...boxes.map((b) => b.y))];
  const right = Math.max(...boxes.map((b) => b.x + b.w));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  return { x, y, w: right - x, h: bottom - y };
}
