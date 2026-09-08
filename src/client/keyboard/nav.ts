import type { CodeViewLineSelection, FileDiffMetadata, SelectionSide } from '@pierre/diffs';
import type { Snapshot } from '../../shared/protocol.js';
import { itemId, orderedPaths } from '../model.js';
import type { DiffStyle, FileView, Loaded } from '../store.js';

export interface Row {
  side: SelectionSide;
  line: number;
  /**
   * Where ] / [ stop: one row per change block, the first added line, or the
   * first deleted line of a pure deletion. Landing on the new side keeps
   * comments and symbol navigation on the code that exists.
   */
  hunkStart: boolean;
}

export interface NavItem {
  id: string;
  path: string;
  collapsed: boolean;
  rows: Row[];
}

/** Inclusive new-side line ranges the viewer expanded out of collapsed context. */
export type LineRange = [start: number, end: number];

/**
 * Rows in display order for a diff, one per visual line, so each j / k moves the
 * eye one line. Unified: context, then a block's deletions, then its additions.
 * Split: a deletion and an addition on the same visual line are one row, on the
 * new side; deletions beyond the additions stay reachable on the old side.
 * `revealed` adds the context lines the viewer expanded (via a jump into
 * collapsed context), so the cursor can walk them like any other row.
 */
export function diffRows(fileDiff: FileDiffMetadata, revealed: LineRange[] = [], style: DiffStyle = 'unified'): Row[] {
  const rows: Row[] = [];
  const extra = revealedLines(fileDiff, revealed);
  let e = 0;
  for (const h of fileDiff.hunks) {
    let o = h.deletionStart;
    let n = h.additionStart;
    while (e < extra.length && extra[e]! < n) rows.push({ side: 'additions', line: extra[e++]!, hunkStart: false });
    for (const block of h.hunkContent) {
      if (block.type === 'context') {
        for (let i = 0; i < block.lines; i++) rows.push({ side: 'additions', line: n + i, hunkStart: false });
        o += block.lines;
        n += block.lines;
      } else {
        const deletion = (i: number): Row => ({ side: 'deletions', line: o + i, hunkStart: i === 0 && block.additions === 0 });
        const addition = (i: number): Row => ({ side: 'additions', line: n + i, hunkStart: i === 0 });
        if (style === 'split') {
          for (let i = 0; i < block.additions; i++) rows.push(addition(i));
          for (let i = block.additions; i < block.deletions; i++) rows.push(deletion(i));
        } else {
          for (let i = 0; i < block.deletions; i++) rows.push(deletion(i));
          for (let i = 0; i < block.additions; i++) rows.push(addition(i));
        }
        o += block.deletions;
        n += block.additions;
      }
    }
  }
  while (e < extra.length) rows.push({ side: 'additions', line: extra[e++]!, hunkStart: false });
  return rows;
}

/** Sorted new-side lines from `revealed` that no hunk already renders. */
function revealedLines(fileDiff: FileDiffMetadata, revealed: LineRange[]): number[] {
  if (revealed.length === 0) return [];
  const known = new Set<number>();
  for (const h of fileDiff.hunks) {
    let n = h.additionStart;
    for (const block of h.hunkContent) {
      const count = block.type === 'context' ? block.lines : block.additions;
      for (let i = 0; i < count; i++) known.add(n + i);
      n += count;
    }
  }
  const lines = new Set<number>();
  for (const [start, end] of revealed) for (let l = start; l <= end; l++) if (!known.has(l)) lines.add(l);
  return [...lines].sort((a, b) => a - b);
}

function fileRows(contents: string): Row[] {
  const lines = contents.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.map((_, i) => ({ side: 'additions' as const, line: i + 1, hunkStart: i === 0 }));
}

/**
 * Ordered navigation model over the review pane's items: every changed file's
 * diff, or, while the file view is open, that one file's whole new side.
 */
export function buildNav(
  snapshot: Snapshot,
  loaded: Record<string, Loaded>,
  gens: Record<string, number>,
  isCollapsed: (path: string) => boolean,
  revealed: Record<string, LineRange[]> = {},
  style: DiffStyle = 'unified',
  fileView: FileView | null = null,
): NavItem[] {
  if (fileView) {
    if (!fileView.item) return [];
    const id = itemId(false, fileView.path, gens[fileView.path] ?? 0);
    return [{ id, path: fileView.path, collapsed: false, rows: rowsOf(fileView.item, revealed[id], style) }];
  }
  const out: NavItem[] = [];
  // Every changed file is an item, loaded or not, so J / K walk the tree in order from the first
  // keypress; a file still loading has no rows yet and lands on its header.
  for (const path of orderedPaths(snapshot)) {
    const l = loaded[path];
    const id = itemId(true, path, gens[path] ?? 0);
    out.push({ id, path, collapsed: isCollapsed(path), rows: l ? rowsOf(l, revealed[id], style) : [] });
  }
  return out;
}

/**
 * Rows keyed by the loaded object, which the store never mutates (a hydrated
 * clone replaces it), plus the `revealed` array and style they were built with.
 * Rebuilding the nav model must not rebuild every row of every file.
 */
const rowCache = new WeakMap<object, { revealed: LineRange[] | undefined; style: DiffStyle; rows: Row[] }>();

function rowsOf(l: Loaded, revealed: LineRange[] | undefined, style: DiffStyle): Row[] {
  const key: object | null = l.kind === 'diff' ? l.fileDiff : l.kind === 'file' ? l.file : null;
  if (!key) return [];
  const hit = rowCache.get(key);
  if (hit && hit.revealed === revealed && hit.style === style) return hit.rows;
  const rows = l.kind === 'diff' ? diffRows(l.fileDiff, revealed, style) : fileRows((l as Extract<Loaded, { kind: 'file' }>).file.contents);
  rowCache.set(key, { revealed, style, rows });
  return rows;
}

export interface Cursor {
  itemIndex: number;
  rowIndex: number;
}

export function cursorFromSelection(nav: NavItem[], sel: CodeViewLineSelection | null): Cursor | null {
  if (!sel) return null;
  const itemIndex = nav.findIndex((n) => n.id === sel.id);
  if (itemIndex === -1) return null;
  const side = sel.range.endSide ?? sel.range.side ?? 'additions';
  const rows = nav[itemIndex]!.rows;
  let rowIndex = rows.findIndex((r) => r.line === sel.range.end && r.side === side);
  if (rowIndex === -1) rowIndex = rows.findIndex((r) => r.line === sel.range.end);
  if (rowIndex === -1) {
    // Selection is on a revealed context line the row model does not know; use the nearest row.
    let best = Infinity;
    rows.forEach((r, i) => {
      const d = Math.abs(r.line - sel.range.end) + (r.side === side ? 0 : 0.5);
      if (d < best) {
        best = d;
        rowIndex = i;
      }
    });
    if (rowIndex === -1) return null;
  }
  return { itemIndex, rowIndex };
}

/** Flattened step over visible rows; skips collapsed items. */
export function step(nav: NavItem[], cur: Cursor | null, delta: 1 | -1): Cursor | null {
  if (nav.length === 0) return null;
  if (!cur) return firstRow(nav, delta === 1 ? 0 : nav.length - 1, delta);
  let { itemIndex, rowIndex } = cur;
  rowIndex += delta;
  while (rowIndex < 0 || rowIndex >= (nav[itemIndex]?.rows.length ?? 0)) {
    itemIndex += delta;
    if (itemIndex < 0 || itemIndex >= nav.length) return cur;
    if (nav[itemIndex]!.collapsed || nav[itemIndex]!.rows.length === 0) continue;
    rowIndex = delta === 1 ? 0 : nav[itemIndex]!.rows.length - 1;
  }
  return { itemIndex, rowIndex };
}

/** First navigable row at or after (delta=1) / before (delta=-1) itemIndex. */
function firstRow(nav: NavItem[], itemIndex: number, delta: 1 | -1 = 1): Cursor | null {
  for (let i = itemIndex; i >= 0 && i < nav.length; i += delta) {
    if (nav[i]!.rows.length > 0) return { itemIndex: i, rowIndex: 0 };
  }
  return null;
}

/** Next/previous item, collapsed ones included: J / K land on a collapsed header so zo can open it. */
export function stepFile(nav: NavItem[], cur: Cursor | null, delta: 1 | -1): Cursor | null {
  if (nav.length === 0) return null;
  const from = cur ? cur.itemIndex + delta : delta === 1 ? 0 : nav.length - 1;
  return { itemIndex: Math.max(0, Math.min(nav.length - 1, from)), rowIndex: 0 };
}

/** Next/previous hunk start across items. */
export function stepHunk(nav: NavItem[], cur: Cursor | null, delta: 1 | -1): Cursor | null {
  const flat: Cursor[] = [];
  nav.forEach((item, itemIndex) => {
    if (item.collapsed) return;
    item.rows.forEach((r, rowIndex) => r.hunkStart && flat.push({ itemIndex, rowIndex }));
  });
  if (flat.length === 0) return cur;
  if (!cur) return delta === 1 ? flat[0]! : flat[flat.length - 1]!;
  const key = (c: Cursor) => c.itemIndex * 1e7 + c.rowIndex;
  const k = key(cur);
  if (delta === 1) return flat.find((c) => key(c) > k) ?? cur;
  return [...flat].reverse().find((c) => key(c) < k) ?? cur;
}

export function selectionFor(nav: NavItem[], cur: Cursor, anchor?: Cursor | null): CodeViewLineSelection | null {
  const item = nav[cur.itemIndex];
  const row = item?.rows[cur.rowIndex];
  if (!item || !row) return null;
  if (anchor && anchor.itemIndex === cur.itemIndex) {
    const a = item.rows[anchor.rowIndex];
    if (a) return { id: item.id, range: { start: a.line, side: a.side, end: row.line, endSide: row.side } };
  }
  return { id: item.id, range: { start: row.line, side: row.side, end: row.line, endSide: row.side } };
}
