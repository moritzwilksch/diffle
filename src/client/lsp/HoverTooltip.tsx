import { useEffect, useRef, type RefObject } from 'react';
import { Markdown } from '../Markdown.js';
import { useStore, type HoverState } from '../store.js';
import { TooltipSurface } from '../ui/Tooltip.js';
import type { TokenTarget } from './target.js';

/** Pointer rest before the server is asked; moving across tokens asks nothing. */
const SHOW_MS = 300;
/** Grace after leaving the token, so the pointer can travel into the tooltip. */
export const LINGER_MS = 150;

// Module state: token enter / leave fire constantly and must not re-render.
// The tooltip stays while the pointer is over its token or over the tooltip. The two reports arrive
// in either order: the diff derives a token leave from the <pre>'s pointerleave, which the browser
// fires after the pointerout React has already turned into the tooltip's enter. So both are tracked
// and the close is derived from them, not from whichever handler ran last.
let overToken = false;
let overTip = false;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
const clearShow = () => {
  if (showTimer) clearTimeout(showTimer);
  showTimer = null;
};
const clearHide = () => {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = null;
};
/** Close after the grace unless the pointer is over the token or the tooltip. */
const settle = () => {
  clearHide();
  if (overToken || overTip) return;
  hideTimer = setTimeout(() => {
    hideTimer = null;
    useStore.getState().closeHover();
  }, LINGER_MS);
};

/** Hover lifecycle for the diff's tokens; the store owns what is shown. */
export const hoverControl = {
  /** The pointer entered `el`, which shows `target`. */
  enter(target: TokenTarget, el: HTMLElement): void {
    overToken = true;
    clearShow();
    settle();
    showTimer = setTimeout(() => {
      showTimer = null;
      const r = el.getBoundingClientRect();
      void useStore.getState().requestHover(target, { left: r.left, top: r.top, bottom: r.bottom });
    }, SHOW_MS);
  },
  /** The pointer left the token: nothing pending shows, and an open tooltip closes unless the pointer is on it. */
  leave(): void {
    overToken = false;
    clearShow();
    settle();
  },
  /** The pointer is inside the tooltip: keep it. */
  tipEnter(): void {
    overTip = true;
    settle();
  },
  /** The pointer left the tooltip, or the tooltip went away from under it. */
  tipLeave(): void {
    // Only a change settles: StrictMode also runs the unmount cleanup once at mount.
    if (!overTip) return;
    overTip = false;
    settle();
  },
  /** Scroll, click, or a key: nothing pending, nothing shown. */
  cancel(): void {
    clearShow();
    clearHide();
    useStore.getState().closeHover();
  },
};

/** Editor-style tooltip below the hovered symbol with the language server's hover text. */
export function HoverTooltip() {
  const hover = useStore((s) => s.hover);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Escape goes through the keymap's `escape()`, which closes the tooltip first; any other key
    // means the reader is working and the tooltip is in the way.
    // Bare modifiers are exempt: Ctrl pressed to prepare a Ctrl+click must not dismiss the tip.
    const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && !MODIFIERS.has(e.key)) hoverControl.cancel();
    };
    // Capture-phase listeners see events from inside the tooltip too (its own scrollbar, a text
    // selection in a signature); those keep it open.
    const inTip = (e: Event) => e.target instanceof Node && !!ref.current?.contains(e.target);
    const cancel = (e: Event) => {
      if (!inTip(e)) hoverControl.cancel();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', cancel, true);
    document.addEventListener('pointerdown', cancel, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', cancel, true);
      document.removeEventListener('pointerdown', cancel, true);
    };
  }, []);
  if (!hover) return null;
  return <Tip hover={hover} boxRef={ref} />;
}

function Tip({ hover, boxRef }: { hover: HoverState; boxRef: RefObject<HTMLDivElement | null> }) {
  // Dismissed from under the pointer (a key, a click elsewhere), the box gets no pointer leave.
  useEffect(() => hoverControl.tipLeave, []);
  return (
    <TooltipSurface
      boxRef={boxRef}
      anchor={hover.anchor}
      className="hover-markdown max-h-[45vh] max-w-[min(40rem,_90vw)] overflow-auto"
      onPointerEnter={hoverControl.tipEnter}
      onPointerLeave={hoverControl.tipLeave}
    >
      <Markdown text={hover.contents} path={hover.target.path} highlight />
    </TooltipSurface>
  );
}
