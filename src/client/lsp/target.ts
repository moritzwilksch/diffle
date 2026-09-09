import type { Side } from '../../shared/protocol.js';
import { NON_CODE_COLORS } from '../theme.js';

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

/** The CSS variable the diff viewer stores a token's light-theme foreground in. */
const TOKEN_COLOR = '--diffs-token-light';

/**
 * Whether a rendered token is code the language server can resolve, as opposed
 * to comment or string text. A token merged from several fragments carries its
 * color on the fragments, not the wrapper.
 */
export function isSymbolToken(el: HTMLElement): boolean {
  const color =
    el.style.getPropertyValue(TOKEN_COLOR) ||
    el.querySelector<HTMLElement>('[style]')?.style.getPropertyValue(TOKEN_COLOR);
  return !color || !NON_CODE_COLORS.has(color.trim().toLowerCase());
}
