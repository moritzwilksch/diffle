import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { twMerge } from 'tailwind-merge';

/** Pointer rest before a control's tooltip appears; the browser's own `title` tip waits about a second. */
const SHOW_MS = 250;
/** Space between the anchor and the tip. */
const GAP = 6;
/** Shared skin. Fixed positioning keeps tooltips out of every scroll container's clipping. */
const SURFACE =
  'fixed z-40 rounded-lg border border-border bg-canvas px-3 py-2 text-[0.75rem] shadow-[0_0.5rem_1.5rem_rgba(0,_0,_0,_0.18)]';

/** Viewport box a tooltip hangs from. */
export interface TipAnchor {
  left: number;
  top: number;
  bottom: number;
}

/** Tooltip box below its anchor, above it near the bottom edge, clamped to the viewport's sides. */
export function TooltipSurface({
  boxRef,
  anchor,
  className,
  children,
  onPointerEnter,
  onPointerLeave,
}: {
  boxRef?: RefObject<HTMLDivElement | null>;
  anchor: TipAnchor;
  className?: string;
  children: ReactNode;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}) {
  const own = useRef<HTMLDivElement>(null);
  const ref = boxRef ?? own;
  // Place after measuring, before paint: the reader never sees the tip jump from its fallback spot.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const below = anchor.bottom + GAP + height <= window.innerHeight;
    el.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8))}px`;
    el.style.top = `${below ? anchor.bottom + GAP : Math.max(8, anchor.top - GAP - height)}px`;
  }, [anchor, ref]);
  return (
    <div
      ref={ref}
      role="tooltip"
      className={twMerge(SURFACE, className)}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      {children}
    </div>
  );
}

interface PlainTip {
  text: string;
  anchor: TipAnchor;
}

/**
 * Turns every `title` into a fast, theme-styled tooltip. The browser's native one is slow and
 * unstyleable, so the host lifts the attribute off the element while the tip is up and puts it
 * back on leave; the element keeps its accessible name for the rest of the time.
 */
export function TooltipHost() {
  const [tip, setTip] = useState<PlainTip | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let active: HTMLElement | null = null;
    let stashed: string | null = null;

    const stop = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const deactivate = () => {
      stop();
      // React may have rewritten the title while the tip was up; then its value is already current.
      if (active && stashed !== null && !active.hasAttribute('title')) active.setAttribute('title', stashed);
      active = null;
      stashed = null;
      setTip(null);
    };
    const show = (el: HTMLElement, text: string, delay: number) => {
      stop();
      const draw = () => {
        const r = el.getBoundingClientRect();
        setTip({ text, anchor: { left: r.left, top: r.top, bottom: r.bottom } });
      };
      if (delay === 0) draw();
      else
        timer = setTimeout(() => {
          timer = null;
          if (active === el) draw();
        }, delay);
    };
    const activate = (el: HTMLElement, delay: number) => {
      if (el === active) return;
      const text = el.getAttribute('title');
      deactivate();
      if (!text) return;
      active = el;
      stashed = text;
      el.removeAttribute('title');
      show(el, text, delay);
    };
    const target = (node: EventTarget | null): HTMLElement | null =>
      node instanceof Element ? node.closest<HTMLElement>('[title]') : null;
    const leaving = (node: EventTarget | null) => !(node instanceof Node) || !active?.contains(node);

    const onOver = (e: Event) => {
      const el = target(e.target);
      if (el) activate(el, SHOW_MS);
    };
    const onOut = (e: Event) => {
      if (active && leaving((e as PointerEvent).relatedTarget)) deactivate();
    };
    const onFocusIn = (e: Event) => {
      const el = target(e.target);
      // `:focus-visible` is false when a click focuses a control, so clicking does not leave a tip behind.
      if (el?.matches(':focus-visible')) activate(el, 0);
    };
    const onFocusOut = (e: Event) => {
      if (active && leaving((e as FocusEvent).relatedTarget)) deactivate();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') deactivate();
    };
    const onMove = () => {
      if (!active) return;
      const text = active.getAttribute('title');
      if (text === null) return;
      // A re-render put the title back while the tip was up: drop the native one and refresh ours.
      stashed = text;
      active.removeAttribute('title');
      show(active, text, 0);
    };
    const onDown = () => deactivate();
    const onScroll = () => deactivate();

    document.addEventListener('pointerover', onOver);
    document.addEventListener('pointerout', onOut);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      stop();
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerout', onOut);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, []);

  if (!tip) return null;
  return (
    <TooltipSurface
      anchor={tip.anchor}
      className="pointer-events-none max-w-[min(28rem,_90vw)] wrap-anywhere whitespace-pre-line"
    >
      {tip.text}
    </TooltipSurface>
  );
}
