import { languageOf, type LspLocation, type Side } from '../../shared/protocol.js';

/** Configuration tokens offer schema hover, without symbol menus or navigation. */
export function schemaHoverOnly(path: string): boolean {
  const language = languageOf(path);
  return language === 'json' || language === 'jsonc' || language === 'yaml' || language === 'toml';
}

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

/** Whether `loc` points into `target`'s token: a definition query asked at the definition itself. */
export function isToken(loc: LspLocation, target: TokenTarget): boolean {
  return (
    !loc.external &&
    loc.path === target.path &&
    loc.line === target.line &&
    loc.col >= target.col &&
    loc.col < target.col + target.text.length
  );
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
