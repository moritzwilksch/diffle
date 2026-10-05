import type { CodeViewHandle } from '@pierre/diffs/react';
import type { CodeViewLineSelection } from '@pierre/diffs';
import { sideOf } from '../comments/anchor.js';
import { itemIdOf, pathFromItemId } from '../model.js';
import { rowOf } from '../review/rows.js';
import { useStore } from '../store.js';
import { occurrenceControl } from './occurrences.js';
import { lspTarget, type TokenTarget } from './target.js';

/** Word runs shared by pointer hit-testing and keyboard navigation; offsets are UTF-16 columns. */
export function wordsIn(text: string): { start: number; text: string }[] {
  return [...text.matchAll(/[\p{L}\p{N}_]+/gu)].map((match) => ({ start: match.index, text: match[0] }));
}

/**
 * Keyboard word focus (vim w / b): walk the identifier tokens of the cursor line
 * on the new side only (the text on disk, which is what the language server
 * sees), crossing to the next or previous line at the ends and skipping deleted
 * lines. Works on the rendered DOM, since tokens exist only there; a CSS
 * highlight marks the focused word without changing the viewer's DOM.
 */
let viewer: () => CodeViewHandle<unknown> | null = () => null;
let focusedEl: HTMLElement | null = null;
let focusedCol: number | null = null;
/** The new-side row the focused word is on, which the cursor must stay on for the focus to hold. */
let focusedRow: { path: string; line: number } | null = null;

interface Word {
  el: HTMLElement;
  col: number;
  text: string;
}

export function setViewer(get: () => CodeViewHandle<unknown> | null): void {
  viewer = get;
}

export function clearWordFocus(): void {
  if (typeof CSS !== 'undefined' && 'highlights' in CSS) CSS.highlights.delete('diffle-word-focus');
  focusedEl = null;
  focusedCol = null;
  focusedRow = null;
  lspTarget.focus(null);
  occurrenceControl.focus(null);
}

/**
 * Called when the selection changed: the focus holds while the cursor stays on the focused
 * word's row and drops once it leaves. Keyed on the row, not on the change itself: a click on a
 * symbol focuses it and then moves the line cursor onto its row, and must not undo itself.
 */
export function onSelectionChanged(sel: CodeViewLineSelection | null): void {
  if (!focusedRow) return;
  if (sel) {
    const path = pathFromItemId(sel.id);
    const line = newSideLine(path, sel.range.end, sideOf(sel) === 'old');
    if (path === focusedRow.path && line === focusedRow.line) return;
  }
  clearWordFocus();
}

/** Focus the clicked word, as `w` would have: the click's target names its token and column. */
export function focusToken(target: TokenTarget, el: HTMLElement): void {
  if (target.side !== 'new') return;
  focusWord({ el, col: target.col, text: target.text }, target.path, target.line);
}

/**
 * Rows the walk may cross before giving up. Words exist only in rendered rows,
 * so the walk stops at the edge of the rendered window anyway; this bounds a
 * screen full of wordless lines.
 */
const MAX_WALK = 200;

export function moveWord(delta: 1 | -1): void {
  const s = useStore.getState();
  const sel = s.selection;
  if (!sel) return;
  const path = pathFromItemId(sel.id);
  const line = newSideLine(path, sel.range.end, sideOf(sel) === 'old');
  const words = line == null ? [] : (wordsOf(path, line) ?? []);
  const idx = words.findIndex((word) => word.el === focusedEl && word.col === focusedCol);
  const next = idx === -1 ? (delta === 1 ? 0 : words.length - 1) : idx + delta;
  if (line != null && next >= 0 && next < words.length) {
    focusWord(words[next]!, path, line);
    return;
  }
  // Off the line, or on a deleted line that has no on-disk text: walk rendered rows until one has words.
  for (let steps = 0; steps < MAX_WALK; steps++) {
    const before = useStore.getState().selection!;
    s.moveCursor(delta);
    const after = useStore.getState().selection;
    if (!after || sameRow(before, after)) break;
    const p = pathFromItemId(after.id);
    const l = newSideLine(p, after.range.end, sideOf(after) === 'old');
    if (l == null) continue;
    const ws = wordsOf(p, l);
    // Off the rendered window: the cursor has moved there, the viewer scrolls it in, and the next `w` continues.
    if (ws == null) break;
    if (ws.length > 0) {
      focusWord(ws[delta === 1 ? 0 : ws.length - 1]!, p, l);
      return;
    }
  }
  clearWordFocus();
}

/** vim 0 / $: focus the first or last identifier of the cursor line; a line without one keeps the focus as is. */
export function moveWordToEdge(edge: 'first' | 'last'): void {
  const s = useStore.getState();
  const sel = s.selection;
  if (!sel) return;
  const path = pathFromItemId(sel.id);
  const line = newSideLine(path, sel.range.end, sideOf(sel) === 'old');
  const words = line == null ? [] : (wordsOf(path, line) ?? []);
  const word = edge === 'first' ? words[0] : words[words.length - 1];
  if (line == null || !word) return s.flash('No symbol on this line');
  focusWord(word, path, line);
}

function sameRow(a: CodeViewLineSelection, b: CodeViewLineSelection): boolean {
  return a.id === b.id && a.range.end === b.range.end && sideOf(a) === sideOf(b);
}

function focusWord({ el, col, text }: Word, path: string, line: number): void {
  clearWordFocus();
  focusedEl = el;
  focusedCol = col;
  focusedRow = { path, line };
  const node = el.firstChild;
  if (
    node?.nodeType === Node.TEXT_NODE &&
    typeof CSS !== 'undefined' &&
    'highlights' in CSS &&
    typeof Highlight !== 'undefined'
  ) {
    const start = col - Number(el.dataset.char);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + text.length);
    const highlight = new Highlight(range);
    // Above the occurrence tint, which paints this word too.
    highlight.priority = 2;
    CSS.highlights.set('diffle-word-focus', highlight);
  }
  const target: TokenTarget = { path, side: 'new', line, col, text };
  lspTarget.focus(target, el);
  occurrenceControl.focus(target);
}

/**
 * The new-side line for a cursor row, since only on-disk text has LSP positions.
 * A context row selected in the old column maps through its alt line; a deleted
 * row has no new-side text and yields null.
 */
function newSideLine(path: string, line: number, onOldSide: boolean): number | null {
  if (!onOldSide) return line;
  const root = rootOf(path);
  const row = root && rowOf(root, line, 'old');
  if (!row || !row.dataset.lineType?.startsWith('context')) return null;
  const alt = Number(row.dataset.altLine);
  return Number.isFinite(alt) ? alt : null;
}

function rootOf(path: string): ShadowRoot | HTMLElement | null {
  const state = useStore.getState();
  const id = itemIdOf(state, path);
  const rendered = viewer()
    ?.getInstance()
    ?.getRenderedItems()
    .find((r) => r.id === id);
  return rendered?.element.shadowRoot ?? rendered?.element ?? null;
}

/** Identifier tokens of a rendered new-side line, in order; null when the row is not rendered. */
function wordsOf(path: string, line: number): Word[] | null {
  const root = rootOf(path);
  const row = root && rowOf(root, line, 'new');
  if (!row) return null;
  return [...row.querySelectorAll<HTMLElement>('span[data-char]')].flatMap((el) =>
    wordsIn(el.textContent ?? '').map((word) => ({
      el,
      col: Number(el.dataset.char) + word.start,
      text: word.text,
    })),
  );
}
