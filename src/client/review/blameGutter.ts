import type { CodeViewHandle } from '@pierre/diffs/react';
import { api } from '@/client/api.js';
import { pathFromItemId, relativeTime } from '@/client/model.js';
import { useStore } from '@/client/store.js';
import type { BlameHunk, BlameResponse } from '@/shared/protocol.js';
import type { Side } from '@/shared/side.js';
import { clearRendered, remember, sideKey } from './blame.js';
import { isDeletionRow, watchRenderedRows } from './rows.js';

/**
 * Blame beside every line number, as an IDE's annotate gutter shows it. Each shown side of a file
 * is blamed whole, once per commit (once per snapshot for the worktree), a few files at a time so
 * a long review does not queue a burst of slow blames.
 */

/** Set on each rendered line-number cell: its label, empty on a run's later lines. */
export const GUTTER_ATTR = 'data-blame-gutter';

const LABEL = '…';
const IN_FLIGHT_MAX = 2;
const FILES_MAX = 200;

/** Every number cell reserves the label's width, loaded or not, so the column never jumps. */
export const BLAME_GUTTER_CSS = `
/* Gutter blame (see blameGutter.ts). */
[data-column-number] { display: flex; justify-content: flex-end; }
[data-column-number]::after {
  content: attr(${GUTTER_ATTR});
  order: -1;
  box-sizing: border-box;
  width: 28ch;
  margin-inline-end: auto;
  padding-inline-end: 2ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: pre;
  text-align: start;
  color: var(--fg-2);
  user-select: none;
}
`;

/** `2026-08-01 Ada Lovelace` in the reader's time zone; uncommitted worktree lines say so. */
export function gutterLabel(res: BlameResponse, hunk: BlameHunk): string {
  if (hunk.commit == null) return 'Not committed yet';
  const commit = res.commits.find((c) => c.sha === hunk.commit);
  if (!commit) return '';
  const d = new Date(commit.time * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${commit.author}`;
}

/** The hover text: what the label leaves out. */
export function gutterTitle(res: BlameResponse, hunk: BlameHunk, now = Date.now()): string {
  const commit = hunk.commit == null ? undefined : res.commits.find((c) => c.sha === hunk.commit);
  if (!commit) return '';
  return `${commit.short} · ${commit.author}, ${relativeTime(commit.time * 1000, now)}\n${commit.summary}`;
}

/** The hunk holding `line`; hunks come in line order. */
export function hunkAt(res: BlameResponse, line: number): BlameHunk | undefined {
  let [lo, hi] = [0, res.hunks.length - 1];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const h = res.hunks[mid]!;
    if (line < h.start) hi = mid - 1;
    else if (line >= h.start + h.lines) lo = mid + 1;
    else return h;
  }
  return undefined;
}

function set(el: HTMLElement, attr: string, value: string): void {
  if (el.getAttribute(attr) !== value) el.setAttribute(attr, value);
}

export function installBlameGutter(
  viewer: () => CodeViewHandle<unknown, undefined> | null,
  scroller: HTMLElement,
): () => void {
  // By `sideKey`: the blame, null when the side has none, 'pending' while asked.
  const files = new Map<string, BlameResponse | null | 'pending'>();
  const queue: { key: string; path: string; side: Side }[] = [];
  let inFlight = 0;
  let stopped = false;
  let repaint = () => {};

  const pump = () => {
    while (!stopped && inFlight < IN_FLIGHT_MAX && queue.length) {
      const { key, path, side } = queue.shift()!;
      inFlight++;
      api
        .blame({ path, side })
        .then(
          (res) => res,
          () => null,
        )
        .then((res) => {
          inFlight--;
          remember(files, key, res, FILES_MAX);
          repaint();
          pump();
        });
    }
  };
  const request = (key: string, path: string, side: Side) => {
    files.set(key, 'pending');
    queue.push({ key, path, side });
    pump();
  };

  const stop = watchRenderedRows(
    viewer,
    scroller,
    (schedule) => {
      repaint = schedule;
      return useStore.subscribe((s, prev) => {
        if (s.snapshot !== prev.snapshot) schedule();
      });
    },
    (items) => {
      const snap = useStore.getState().snapshot;
      if (!snap) return;
      for (const { id, root } of items) {
        const path = pathFromItemId(id);
        for (const code of root.querySelectorAll('code')) {
          // A run's label shows on its first visible line: after a gap, it shows again.
          const last: Record<Side, { line: number; hunk?: BlameHunk }> = { old: { line: -1 }, new: { line: -1 } };
          for (const cell of code.querySelectorAll<HTMLElement>('[data-column-number]')) {
            const side: Side = isDeletionRow(cell) ? 'old' : 'new';
            const line = Number(cell.dataset.columnNumber);
            const key = sideKey(snap, path, side);
            const res = files.get(key);
            if (res === undefined) request(key, path, side);
            if (res === undefined || res === 'pending') {
              set(cell, GUTTER_ATTR, LABEL);
              continue;
            }
            const hunk = res ? hunkAt(res, line) : undefined;
            const runs = hunk != null && last[side].hunk === hunk && last[side].line === line - 1;
            last[side] = { line, hunk };
            set(cell, GUTTER_ATTR, hunk && res && !runs ? gutterLabel(res, hunk) : '');
            const title = hunk && res ? gutterTitle(res, hunk) : '';
            if (title) set(cell, 'title', title);
            else cell.removeAttribute('title');
          }
        }
      }
    },
  );
  return () => {
    stopped = true;
    stop();
    clearRendered(viewer, GUTTER_ATTR, ['title']);
  };
}
