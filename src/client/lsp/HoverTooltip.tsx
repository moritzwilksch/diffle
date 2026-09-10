import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { Markdown } from '../Markdown.js';
import { useStore, type HoverState } from '../store.js';
import type { TokenTarget } from './target.js';

/** Pointer rest before the server is asked; moving across tokens asks nothing. */
const SHOW_MS = 300;
/** Grace after leaving the token, so the pointer can travel into the tooltip. */
const LINGER_MS = 150;
const GAP = 4;

// Module state: token enter / leave fire constantly and must not re-render.
let showTimer: ReturnType<typeof setTimeout> | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
const clear = () => {
  if (showTimer) clearTimeout(showTimer);
  if (hideTimer) clearTimeout(hideTimer);
  showTimer = hideTimer = null;
};

/** Hover lifecycle for the diff's tokens; the store owns what is shown. */
export const hoverControl = {
  /** The pointer entered `el`, which shows `target`. */
  enter(target: TokenTarget, el: HTMLElement): void {
    clear();
    showTimer = setTimeout(() => {
      showTimer = null;
      const r = el.getBoundingClientRect();
      void useStore.getState().requestHover(target, { left: r.left, top: r.top, bottom: r.bottom });
    }, SHOW_MS);
  },
  /** The pointer left the token: nothing pending shows, and an open tooltip closes unless the pointer reaches it. */
  leave(): void {
    clear();
    hideTimer = setTimeout(() => {
      hideTimer = null;
      useStore.getState().closeHover();
    }, LINGER_MS);
  },
  /** The pointer is inside the tooltip: keep it. */
  hold(): void {
    clear();
  },
  /** Scroll, click, or a key: nothing pending, nothing shown. */
  cancel(): void {
    clear();
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
  return <Tip hover={hover} ref={ref} />;
}

function Tip({ hover, ref }: { hover: HoverState; ref: RefObject<HTMLDivElement | null> }) {
  // Place after measuring, before paint: below the token, above it when the bottom edge is near,
  // clamped to the viewport's right edge.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const { left, top, bottom } = hover.anchor;
    const below = bottom + GAP + height <= window.innerHeight;
    el.style.left = `${Math.max(8, Math.min(left, window.innerWidth - width - 8))}px`;
    el.style.top = `${below ? bottom + GAP : Math.max(8, top - GAP - height)}px`;
  }, [hover, ref]);
  return (
    <div
      ref={ref}
      className="hover-markdown fixed z-40 max-h-[45vh] max-w-[min(40rem,_90vw)] overflow-auto rounded-lg border border-border bg-canvas px-3 py-2 text-[0.75rem] shadow-[0_0.5rem_1.5rem_rgba(0,_0,_0,_0.18)]"
      role="tooltip"
      onPointerEnter={hoverControl.hold}
      onPointerLeave={hoverControl.leave}
    >
      <Markdown text={hover.contents} path={hover.target.path} highlight />
    </div>
  );
}
