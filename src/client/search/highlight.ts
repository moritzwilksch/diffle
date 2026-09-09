import type { CodeViewHandle } from '@pierre/diffs/react';
import { pathFromItemId } from '../model.js';
import { isDeletionRow, watchRenderedRows } from '../review/rows.js';
import { useStore, type SearchState } from '../store.js';

/**
 * Paint every occurrence of the current verbatim search (g/ text, * / # word)
 * in the rendered code, with the match the cursor sits on painted stronger.
 * Uses the CSS Custom Highlight API so the viewer's DOM is never mutated;
 * the styles live in the viewer's injected CSS (`::highlight(diffle-search)`).
 * Rows come and go with virtualization, so the pass reruns whenever the
 * rendered rows or the store's search change (`watchRenderedRows`); per-row
 * matches are cached so a pass only rescans new or changed rows.
 */

const ALL = 'diffle-search';
const CURRENT = 'diffle-search-current';

/** The regex the highlighter paints for `search`; null when nothing verbatim is active. */
export function matchPattern(search: SearchState): RegExp | null {
  if (!search.open || !search.query || search.matches.length === 0) return null;
  const literal = search.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    if (search.kind === 'word') return new RegExp(`(?<![\\p{L}\\p{N}_])${literal}(?![\\p{L}\\p{N}_])`, 'gu');
    if (search.kind === 'text')
      return new RegExp(search.regex ? search.query : literal, search.ignoreCase ? 'gi' : 'g');
  } catch {
    return null;
  }
  return null;
}

/** DOM ranges over the matches of `pattern` in `el`'s text, spanning token boundaries. */
function rangesIn(el: Element, pattern: RegExp): Range[] {
  const nodes: Text[] = [];
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let text = '';
  const starts: number[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push(n as Text);
    starts.push(text.length);
    text += (n as Text).data;
  }
  if (!text) return [];
  const out: Range[] = [];
  pattern.lastIndex = 0;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    if (m[0].length === 0) {
      pattern.lastIndex++;
      continue;
    }
    const range = el.ownerDocument.createRange();
    const [sNode, sOff] = locate(nodes, starts, m.index);
    const [eNode, eOff] = locate(nodes, starts, m.index + m[0].length, true);
    range.setStart(sNode, sOff);
    range.setEnd(eNode, eOff);
    out.push(range);
  }
  return out;
}

/** Text node and offset for a flat offset; `end` keeps a boundary inside the earlier node. */
function locate(nodes: Text[], starts: number[], offset: number, end = false): [Text, number] {
  let i = starts.length - 1;
  while (i > 0 && (end ? starts[i]! >= offset : starts[i]! > offset)) i--;
  return [nodes[i]!, offset - starts[i]!];
}

/**
 * Match ranges per rendered row, keyed by the row element. A row is scanned once per
 * pattern; the mutation observer drops rows whose text changed, and virtualization
 * hands out fresh elements for re-rendered rows, so a scroll frame that exposes no new
 * code walks no text at all. `scan` is injectable so tests can count row scans.
 */
export class MatchCache {
  private key = '';
  private rows = new WeakMap<Element, Range[]>();
  constructor(private readonly scan: (el: Element, pattern: RegExp) => Range[] = rangesIn) {}

  /** Ranges for `pattern` in `row`, scanning only when the row is new or the pattern changed. */
  rangesFor(row: Element, pattern: RegExp): Range[] {
    const key = `${pattern.flags}/${pattern.source}`;
    if (key !== this.key) {
      this.key = key;
      this.rows = new WeakMap();
    }
    let ranges = this.rows.get(row);
    if (!ranges) {
      ranges = this.scan(row, pattern);
      this.rows.set(row, ranges);
    }
    return ranges;
  }

  /** Forget the row containing `node`, so the next pass rescans it. */
  invalidate(node: Node): void {
    const el = node instanceof Element ? node : node.parentElement;
    const row = el?.closest('[data-line]');
    if (row) this.rows.delete(row);
  }
}

const supported = (): boolean => typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

export function installSearchHighlights(
  viewer: () => CodeViewHandle<unknown> | null,
  scroller: HTMLElement,
): () => void {
  if (!supported()) return () => {};
  const cache = new MatchCache();
  const stop = watchRenderedRows(
    viewer,
    scroller,
    (schedule) =>
      useStore.subscribe((s, prev) => {
        if (s.search !== prev.search || s.loaded !== prev.loaded || s.collapsed !== prev.collapsed) schedule();
      }),
    (items) => {
      const search = useStore.getState().search;
      const pattern = matchPattern(search);
      if (!pattern) {
        CSS.highlights.delete(ALL);
        CSS.highlights.delete(CURRENT);
        return;
      }
      const current = search.matches[search.index];
      const all: Range[] = [];
      const cur: Range[] = [];
      for (const { id, root } of items) {
        const path = pathFromItemId(id);
        for (const row of root.querySelectorAll<HTMLElement>('[data-line]')) {
          // Matches are new-side lines; a deleted row's text is not on disk.
          if (isDeletionRow(row)) continue;
          const here = current != null && current.path === path && Number(row.dataset.line) === current.line;
          for (const r of cache.rangesFor(row, pattern)) (here ? cur : all).push(r);
        }
      }
      CSS.highlights.set(ALL, new Highlight(...all));
      CSS.highlights.set(CURRENT, new Highlight(...cur));
    },
    (records) => {
      for (const r of records) cache.invalidate(r.target);
    },
  );
  return () => {
    stop();
    CSS.highlights.delete(ALL);
    CSS.highlights.delete(CURRENT);
  };
}
