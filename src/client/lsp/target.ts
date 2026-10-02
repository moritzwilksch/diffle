import { languageOf, type Side } from '../../shared/protocol.js';

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
  /** The highlighter's classification of the rendered token; absent where it made none. */
  tokenType?: HighlightTokenType | null;
}

/** Shiki's TextMate token classes, as `@pierre/diffs` renders them onto token spans. */
export type HighlightTokenType = 'comment' | 'string' | 'regex';

const TOKEN_TYPES: readonly string[] = ['comment', 'string', 'regex'];

/**
 * The highlighter's class for the token `el` renders, read from the span it already
 * painted. Synchronous: the diff viewer classified this text when it tokenized the
 * file, so a click needs no parse of its own.
 */
export function tokenTypeAt(el: Element | null): HighlightTokenType | null {
  const type = el?.closest<HTMLElement>('[data-token-type]')?.dataset.tokenType;
  return type != null && TOKEN_TYPES.includes(type) ? (type as HighlightTokenType) : null;
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
