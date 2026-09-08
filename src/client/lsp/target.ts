import type { Side } from '../../shared/protocol.js';

/** The token `gd` / `gA` act on: keyboard-focused (w / b) first, else under the pointer. */
export interface TokenTarget {
  path: string;
  side: Side;
  /** 1-based. */
  line: number;
  /** 0-based UTF-16 offset in the line. */
  col: number;
  text: string;
}

// Module state, not store state: hover fires constantly and must not re-render.
let hovered: TokenTarget | null = null;
let hoveredEl: HTMLElement | null = null;
let focused: TokenTarget | null = null;
let focusedEl: HTMLElement | null = null;

export const lspTarget = {
  get: (): TokenTarget | null => focused ?? hovered,
  /** The element showing `get()`'s token, so a keyboard-opened tooltip can hang from it. */
  element: (): HTMLElement | null => (focused ? focusedEl : hoveredEl),
  set(t: TokenTarget | null, el: HTMLElement | null = null): void {
    hovered = t;
    hoveredEl = t ? el : null;
  },
  focus(t: TokenTarget | null, el: HTMLElement | null = null): void {
    focused = t;
    focusedEl = t ? el : null;
  },
};
