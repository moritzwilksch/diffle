import type { CodeViewHandle } from '@pierre/diffs/react';
import type { LspOccurrence } from '../../shared/protocol.js';
import { pathFromItemId } from '../model.js';
import { isDeletionRow, watchRenderedRows } from '../review/rows.js';
import { useStore } from '../store.js';
import type { TokenTarget } from './target.js';
import { tokenRange } from './tokenText.js';

/**
 * Occurrence highlighting: when the keyboard word focus (w / b / 0 / $) lands on a
 * symbol, or the pointer rests on one, every other place that symbol occurs in the
 * same file is tinted, reads and writes apart. The language server's
 * `textDocument/documentHighlight` is the only source, so scope and shadowing are
 * respected. Painted with the CSS Custom Highlight API, so the viewer's DOM is never
 * mutated; the styles live in the viewer's injected CSS (`::highlight(diffle-occurrence…)`).
 * Occurrences are new-side positions, so deleted rows never paint.
 */

/** Pause after the last keyboard focus change before asking: swallows key auto-repeat. */
export const KEY_MS = 80;
/** Pause after the pointer settles on a word; shorter than the hover tooltip's, so the tint arrives first. */
export const POINTER_MS = 150;

export const HIGHLIGHTS: Record<LspOccurrence['kind'], string> = {
  text: 'diffle-occurrence',
  read: 'diffle-occurrence-read',
  write: 'diffle-occurrence-write',
};

/** Answers kept for the current snapshot, so the tint returns at once when a target comes back. */
const CACHE_MAX = 64;

/**
 * DOM ranges to paint in a rendered row of `line` for `occurrences`, each with its kind.
 * Columns are UTF-16 offsets into the line; the row's `span[data-char]` tokens carry the column
 * they start at, and a range stays inside one token, so an occurrence crossing tokens yields one
 * range per token. An occurrence spanning lines is clipped to this one.
 */
export function occurrenceRanges(
  row: HTMLElement,
  line: number,
  occurrences: readonly LspOccurrence[],
): { range: Range; kind: LspOccurrence['kind'] }[] {
  const here = occurrences.filter((o) => o.line <= line && line <= o.endLine);
  if (!here.length) return [];
  const out: { range: Range; kind: LspOccurrence['kind'] }[] = [];
  for (const token of row.querySelectorAll<HTMLElement>('span[data-char]')) {
    const start = Number(token.dataset.char);
    const length = token.textContent?.length ?? 0;
    if (!Number.isFinite(start) || !length) continue;
    for (const o of here) {
      const from = Math.max(o.line === line ? o.col : 0, start);
      const to = Math.min(o.endLine === line ? o.endCol : Infinity, start + length);
      if (from >= to) continue;
      const range = tokenRange(token, from - start, to - start);
      if (range) out.push({ range, kind: o.kind });
    }
  }
  return out;
}

// Module state, not store state: pointer enter / leave fire constantly and must not re-render.
let focused: TokenTarget | null = null;
let hovered: TokenTarget | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let cache = new Map<string, LspOccurrence[]>();
let cacheVersion: number | null = null;

const keyOf = (t: TokenTarget) => `${t.path}\0${t.line}\0${t.col}`;

function cacheFor(): Map<string, LspOccurrence[]> | null {
  const version = useStore.getState().snapshot?.version ?? null;
  if (version == null) return null;
  if (version !== cacheVersion) {
    cacheVersion = version;
    cache = new Map();
  }
  return cache;
}

/** The pointer's symbol wins while it rests on one; otherwise the keyboard focus. Newest target wins. */
function retarget(pause: number): void {
  if (timer) clearTimeout(timer);
  timer = null;
  const target = hovered ?? focused;
  const s = useStore.getState();
  if (!target) return s.clearOccurrences();
  if (s.occurrences && keyOf(s.occurrences.target) === keyOf(target)) return;
  // A tint still on screen belongs to another symbol: drop it rather than let it mislead.
  s.clearOccurrences();
  const known = cacheFor()?.get(keyOf(target));
  if (known) {
    if (known.length) useStore.setState({ occurrences: { target, items: known } });
    return;
  }
  timer = setTimeout(() => {
    timer = null;
    void useStore
      .getState()
      .requestOccurrences(target)
      .then((items) => {
        // An empty answer is cheap to ask again and may be a server still warming up.
        if (!items?.length) return;
        const c = cacheFor();

        if (!c) return;
        c.set(keyOf(target), items);
        for (const key of c.keys()) {
          if (c.size <= CACHE_MAX) break;
          c.delete(key);
        }
      });
  }, pause);
}

export const occurrenceControl = {
  /** The keyboard word focus moved to `target`, or went away. */
  focus(target: TokenTarget | null): void {
    focused = target;
    if (!hovered) retarget(KEY_MS);
  },
  /** The pointer rests on `target`, or left its word; leaving hands back to the keyboard focus. */
  hover(target: TokenTarget | null): void {
    hovered = target;
    retarget(target ? POINTER_MS : KEY_MS);
  },
  /** Test seam: forget both sources and any pending request. */
  reset(): void {
    focused = null;
    hovered = null;
    if (timer) clearTimeout(timer);
    timer = null;
    cache = new Map();
    cacheVersion = null;
  },
};

const supported = (): boolean => typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

/** Index occurrences by the lines they touch, so a pass over many rows stays linear. */
function byLine(items: readonly LspOccurrence[]): Map<number, LspOccurrence[]> {
  const map = new Map<number, LspOccurrence[]>();
  for (const o of items)
    for (let line = o.line; line <= o.endLine; line++) {
      const list = map.get(line);
      if (list) list.push(o);
      else map.set(line, [o]);
    }
  return map;
}

/** Repaints the occurrences of the store's target as the rendered rows change. Returns the teardown. */
export function installOccurrenceHighlights(
  viewer: () => CodeViewHandle<unknown, undefined> | null,
  scroller: HTMLElement,
): () => void {
  if (!supported()) return () => {};
  const clear = () => {
    for (const name of Object.values(HIGHLIGHTS)) CSS.highlights.delete(name);
  };
  const stop = watchRenderedRows(
    viewer,
    scroller,
    (schedule) =>
      useStore.subscribe((s, prev) => {
        if (s.occurrences !== prev.occurrences || s.loaded !== prev.loaded || s.collapsed !== prev.collapsed)
          schedule();
      }),
    (items) => {
      const occurrences = useStore.getState().occurrences;
      if (!occurrences) return clear();
      const lines = byLine(occurrences.items);
      const ranges: Record<LspOccurrence['kind'], Range[]> = { text: [], read: [], write: [] };
      for (const { id, root } of items) {
        if (pathFromItemId(id) !== occurrences.target.path) continue;
        for (const row of root.querySelectorAll<HTMLElement>('[data-line]')) {
          // Occurrences are new-side positions; a deleted row's text is not on disk.
          if (isDeletionRow(row)) continue;
          const line = Number(row.dataset.line);
          const here = lines.get(line);
          if (!here) continue;
          for (const { range, kind } of occurrenceRanges(row, line, here)) ranges[kind].push(range);
        }
      }
      for (const kind of Object.keys(ranges) as LspOccurrence['kind'][]) {
        const highlight = new Highlight(...ranges[kind]);
        // Below the word focus, which underlines the one occurrence the keyboard is on.
        highlight.priority = 1;
        CSS.highlights.set(HIGHLIGHTS[kind], highlight);
      }
    },
  );
  return () => {
    stop();
    clear();
  };
}
