import type { CodeViewHandle } from '@pierre/diffs/react';
import { api } from '@/client/api.js';
import { pathFromItemId, relativeTime } from '@/client/model.js';
import { useStore, type ReviewState } from '@/client/store.js';
import type { BlameResponse, Snapshot } from '@/shared/protocol.js';
import type { Side } from '@/shared/side.js';
import { rowOf, watchRenderedRows } from './rows.js';

/**
 * The cursor line's blame, trailing its code the way an editor's inline blame does. The note is
 * set as `data-blame` on the rendered row and the viewer's injected CSS draws it, so it never
 * enters the text a reader selects or copies.
 */

/** Set on the cursor's rendered row; its value is the note. */
export const BLAME_ATTR = 'data-blame';
/** Set beside it on an empty row, whose only text is a newline the note would land after. */
const EMPTY_ATTR = 'data-blame-empty';

/** Cursor rest before asking about a file not yet blamed, so holding j across files does not ask for each. */
const SETTLE_MS = 50;
const SUMMARY_MAX = 72;
/** Gap between the code and the note. */
const GAP_CH = 4;
/** Less room than this after the gap and the note is left out: a stub of a name says nothing. */
const MIN_CH = 15;
/** File sides kept, oldest dropped first. */
const FILES_MAX = 200;

export const BLAME_CSS = `
/* The cursor line's blame (see blame.ts). A zero-width box that overflows: the note never wraps the
   line, grows its row, or widens its column, so moving the cursor shifts nothing. The row clips it at its
   own edge, and blame.ts shortens it to the room it measured, so it ends in an ellipsis inside the line.
   An empty row's text is a lone line break, so its note goes before it rather than on a line of its own. */
[data-line][${BLAME_ATTR}] { overflow-x: clip; }
[data-line][${BLAME_ATTR}]:not([${EMPTY_ATTR}])::after,
[data-line][${BLAME_ATTR}][${EMPTY_ATTR}]::before {
  content: attr(${BLAME_ATTR});
  display: inline-block;
  width: 0;
  text-indent: ${GAP_CH}ch;
  color: var(--fg-2);
  user-select: none;
  pointer-events: none;
  white-space: pre;
}
`;

/**
 * Room left on `row` after its text, up to the row's end or the visible edge of its scroller, in px;
 * none while the text's end is scrolled out of view, where only the note's tail would show.
 */
function roomAfter(row: HTMLElement): number {
  const box = row.getBoundingClientRect();
  const cs = getComputedStyle(row);
  const range = document.createRange();
  range.selectNodeContents(row);
  // The last line box's end: a wrapped line's note sits after its last visual line.
  const last = [...range.getClientRects()].findLast((r) => r.width > 0);
  const end = last ? last.right : box.left + parseFloat(cs.paddingLeft);
  const code = row.closest('code');
  if (!code) return 0;
  const view = code.getBoundingClientRect();
  // The line numbers stay put over the code as it scrolls sideways.
  const left = code.querySelector('[data-column-number]')?.getBoundingClientRect().right ?? view.left;
  if (end < left) return 0;
  return Math.min(box.right - parseFloat(cs.paddingRight), view.left + code.clientWidth) - end;
}

const chWidths = new Map<string, number>();
/** One character's width in `el`'s monospace font, measured in the page: its `font` shorthand can read empty. */
function chOf(el: HTMLElement): number {
  const { fontFamily, fontSize, fontWeight, fontFeatureSettings, letterSpacing } = getComputedStyle(el);
  const key = [fontFamily, fontSize, fontWeight, fontFeatureSettings, letterSpacing].join('|');
  let ch = chWidths.get(key);
  if (ch == null) {
    const probe = document.createElement('span');
    Object.assign(probe.style, { fontFamily, fontSize, fontWeight, fontFeatureSettings, letterSpacing });
    Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre' });
    probe.textContent = '0'.repeat(100);
    document.body.append(probe);
    ch = probe.getBoundingClientRect().width / 100 || 8;
    probe.remove();
    chWidths.set(key, ch);
  }
  return ch;
}

type Viewer = () => CodeViewHandle<unknown, undefined> | null;

/**
 * Names what one side of `path` blames to: a commit's blame never changes, so it outlives
 * snapshots; the worktree's holds for one snapshot only.
 */
export function sideKey(snap: Pick<Snapshot, 'oldSha' | 'newSha' | 'version'>, path: string, side: Side): string {
  const rev = side === 'new' ? snap.newSha : snap.oldSha;
  return `${rev === 'worktree' ? `worktree@${snap.version}` : rev}\0${path}`;
}

/** Drops `attr`, and `also` from the same elements, across the rendered items, when a blame mode is switched off. */
export function clearRendered(viewer: Viewer, attr: string, also: string[] = []): void {
  for (const item of viewer()?.getInstance()?.getRenderedItems() ?? []) {
    const root = item.element.shadowRoot ?? item.element;
    for (const el of root.querySelectorAll(`[${attr}]`)) for (const a of [attr, ...also]) el.removeAttribute(a);
  }
}

/** Bounded insert: the map keeps insertion order, so the first key is the oldest. */
export function remember<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value!);
}

/** One blamed line: where the cursor rests, and the file side it rests in. */
interface Target {
  id: string;
  path: string;
  side: Side;
  line: number;
  key: string;
}

function targetOf(s: Pick<ReviewState, 'selection' | 'snapshot'>): Target | null {
  const sel = s.selection;
  if (!sel || !s.snapshot) return null;
  const side = (sel.range.endSide ?? sel.range.side) === 'deletions' ? 'old' : 'new';
  const path = pathFromItemId(sel.id);
  return { id: sel.id, path, side, line: sel.range.end, key: sideKey(s.snapshot, path, side) };
}

/** "Ada Lovelace, 3 days ago · Fix the parser" for `line`, or null when the response does not cover it. */
export function blameNote(res: BlameResponse, line: number, now = Date.now()): string | null {
  const hunk = res.hunks.find((h) => line >= h.start && line < h.start + h.lines);
  if (!hunk) return null;
  if (hunk.commit == null) return 'Not committed yet';
  const commit = res.commits.find((c) => c.sha === hunk.commit);
  if (!commit) return null;
  const summary = commit.summary.length > SUMMARY_MAX ? `${commit.summary.slice(0, SUMMARY_MAX - 1)}…` : commit.summary;
  return `${commit.author}, ${relativeTime(commit.time * 1000, now)} · ${summary}`;
}

export function installBlame(viewer: Viewer, scroller: HTMLElement): () => void {
  // Whole-file blames by `sideKey`; null when that side has no blame to show.
  const files = new Map<string, BlameResponse | null>();
  let pending = '';
  let timer = 0;
  let repaint = () => {};

  const request = (t: Target) => {
    if (pending === t.key) return;
    pending = t.key;
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      api.blame({ path: t.path, side: t.side }).then(
        (res) => settle(t, res),
        // A side with no history, or a file the snapshot no longer has: nothing to say.
        () => settle(t, null),
      );
    }, SETTLE_MS);
  };
  const settle = (t: Target, res: BlameResponse | null) => {
    if (pending === t.key) pending = '';
    remember(files, t.key, res, FILES_MAX);
    repaint();
  };

  // The cursor row's code column scrolls sideways on its own, and resizes with the pane and the
  // sidebars: both change the room.
  let column: Element | null = null;
  const onMove = () => repaint();
  const resized = new ResizeObserver(onMove);
  // A width measured before the web font arrived is the fallback's.
  const onFonts = () => {
    chWidths.clear();
    repaint();
  };
  document.fonts.addEventListener('loadingdone', onFonts);
  const follow = (code: Element | null) => {
    if (code === column) return;
    column?.removeEventListener('scroll', onMove);
    if (column) resized.unobserve(column);
    code?.addEventListener('scroll', onMove, { passive: true });
    if (code) resized.observe(code);
    column = code;
  };

  const stop = watchRenderedRows(
    viewer,
    scroller,
    (schedule) => {
      repaint = schedule;
      return useStore.subscribe((s, prev) => {
        if (s.selection !== prev.selection || s.snapshot !== prev.snapshot) schedule();
      });
    },
    (items) => {
      const t = targetOf(useStore.getState());
      const blame = t ? files.get(t.key) : undefined;
      if (t && blame === undefined) request(t);
      const note = t && blame ? blameNote(blame, t.line) : null;
      let shown: HTMLElement | null = null;
      let target: HTMLElement | null = null;
      for (const { id, root } of items) {
        const row = t && note && id === t.id ? rowOf(root, t.line, t.side) : null;
        if (!row || !t || !note) continue;
        target = row;
        const ch = chOf(row);
        const room = roomAfter(row);
        const fits = Math.floor(room / ch) - GAP_CH;
        if (fits < MIN_CH) continue;
        shown = row;
        const text = note.length <= fits ? note : `${note.slice(0, fits - 1).trimEnd()}…`;
        if (row.getAttribute(BLAME_ATTR) !== text) {
          row.setAttribute(BLAME_ATTR, text);
          row.toggleAttribute(EMPTY_ATTR, /^[\r\n]*$/.test(row.textContent ?? ''));
        }
      }
      for (const { root } of items)
        for (const el of root.querySelectorAll<HTMLElement>(`[${BLAME_ATTR}]`)) {
          if (el === shown) continue;
          el.removeAttribute(BLAME_ATTR);
          el.removeAttribute(EMPTY_ATTR);
        }
      follow(target?.closest('code') ?? null);
    },
  );
  return () => {
    clearTimeout(timer);
    follow(null);
    resized.disconnect();
    document.fonts.removeEventListener('loadingdone', onFonts);
    stop();
    clearRendered(viewer, BLAME_ATTR, [EMPTY_ATTR]);
  };
}
