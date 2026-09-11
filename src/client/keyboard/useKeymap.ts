import { useEffect, useRef } from 'react';
import { copyText } from '../clipboard.js';
import { api } from '../api.js';
import { clearWordFocus, moveWord, moveWordToEdge } from '../lsp/wordNav.js';
import { currentPath, widenSearchScope } from '../model.js';
import { remPx } from '../scale.js';
import { useStore, type ReviewState } from '../store.js';
import { nextTheme } from '../theme.js';

const CHORD_MS = 800;
const PREFIXES = new Set(['g', 'd', 'y', 'z']);

type Action = (s: ReviewState) => unknown;

/**
 * Chords that take a vim-style count typed before them: `123gg` / `123G` jump to
 * line 123 of the current file, `10j` / `10k` walk ten lines down / up.
 */
const COUNTED: Record<string, (s: ReviewState, count: number) => unknown> = {
  gg: (s, n) => void s.goToLine(n),
  G: (s, n) => void s.goToLine(n),
  j: (s, n) => s.moveCursorBy(n),
  k: (s, n) => s.moveCursorBy(-n),
};

/** Single keys and two-key chords, by the key string(s) of the keydown events. */
const KEYMAP: Record<string, Action> = {
  w: () => moveWord(1),
  b: () => moveWord(-1),
  '0': () => moveWordToEdge('first'),
  $: () => moveWordToEdge('last'),
  j: (s) => s.moveCursor(1),
  k: (s) => s.moveCursor(-1),
  J: (s) => s.moveFile(1),
  K: (s) => s.moveFile(-1),
  ']': (s) => s.moveHunk(1),
  '[': (s) => s.moveHunk(-1),
  '*': (s) => s.searchWord(1),
  '#': (s) => s.searchWord(-1),
  n: (s) => (s.search.matches.length ? s.moveMatch(1) : s.moveHunk(1)),
  N: (s) => (s.search.matches.length ? s.moveMatch(-1) : s.moveHunk(-1)),
  gg: (s) => s.moveFile('first'),
  G: (s) => s.moveFile('last'),
  V: (s) => s.toggleVisual(),
  c: (s) => s.selection && s.openDraft(s.selection),
  e: (s) => s.editCommentAtCursor(),
  dd: (s) => s.deleteCommentAtCursor(),
  R: (s) => s.toggleResolvedAtCursor(),
  v: (s) => s.toggleViewedAtCursor(),
  zo: (s) => s.setCollapsedAtCursor(false),
  zc: (s) => s.setCollapsedAtCursor(true),
  zC: (s) => s.setAllCollapsed(true),
  zO: (s) => s.setAllCollapsed(false),
  zt: (s) => s.scrollCursorTo('top'),
  zb: (s) => s.scrollCursorTo('bottom'),
  zz: (s) => s.scrollCursorTo('eye'),
  s: (s) => s.setDiffStyle(s.diffStyle === 'split' ? 'unified' : 'split'),
  t: (s) => s.setTheme(nextTheme(s.theme)),
  yy: () => void copyComments(),
  Y: () => void copyComments(),
  '/': (s) => s.openSearch('file'),
  'g/': (s) => s.openSearch(widenSearchScope(s.search.scope)),
  gf: (s) => s.treeModel?.openSearch(),
  gd: (s) => s.goToDefinition(),
  gy: (s) => s.goToTypeDefinition(),
  gh: (s) => s.showHover(),
  gA: (s) => s.findReferences(),
  gs: (s) => s.openSymbols('document'),
  gS: (s) => s.openSymbols('workspace'),
  F: (s) => {
    const path = currentPath(s);
    if (!s.fileView && path) void s.openFullFile(path);
  },
  o: (s) => s.setGithubMenuOpen(!s.githubMenuOpen),
  m: (s) => s.setModeMenuOpen(!s.modeMenuOpen),
  '?': (s) => s.setHelpOpen(!s.helpOpen),
};

/** Real target, looking through shadow roots (the tree and diffs retarget events to their hosts). */
function realTarget(e: Event): HTMLElement | null {
  const path = e.composedPath();
  return (path[0] as HTMLElement | undefined) ?? (e.target as HTMLElement | null);
}

/**
 * Whether Ctrl or Alt is a real modifier on this press. AltGr (Windows reports
 * it as Ctrl+Alt; Linux as `AltGraph`) is how `[`, `]`, `#` are typed on many
 * layouts, so a single printable character produced through it counts as plain.
 */
export function hasModifier(e: KeyboardEvent): boolean {
  if (!e.ctrlKey && !e.altKey) return false;
  if ([...e.key].length !== 1) return true;
  return !((e.ctrlKey && e.altKey) || e.getModifierState('AltGraph'));
}

function isEditable(el: HTMLElement | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || el.isContentEditable;
}

/**
 * Vim-style keymap. Single keys act immediately; `g`, `d`, `y`, `z` start a
 * chord that resolves on the next key or expires. Ignored while typing in a
 * field, except Escape.
 */
export function useKeymap(): void {
  const pending = useRef<{ key: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  // Digits typed before a chord, as in vim; any key that is not part of the count or a counted chord drops it.
  const count = useRef('');

  useEffect(() => {
    const clearPending = () => {
      if (pending.current) clearTimeout(pending.current.timer);
      pending.current = null;
    };
    const dispatch = (e: KeyboardEvent) => {
      // Modifier presses (e.g. Shift before `M` in `zM`) must not consume a pending chord.
      if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta' || e.key === 'CapsLock')
        return;
      const s = useStore.getState();
      const target = realTarget(e);
      // The count belongs to this press: every path below either uses it or, by
      // leaving it taken, drops it as vim does on a key that takes no count.
      const typed = count.current;
      count.current = '';
      const n = Number(typed);
      // Let a ref field dismiss its suggestions before Escape closes the mode picker.
      if (
        e.key === 'Escape' &&
        target?.getAttribute('role') === 'combobox' &&
        target.getAttribute('aria-expanded') === 'true'
      )
        return;
      if (e.key === 'Escape') {
        if (isEditable(target)) {
          target!.blur();
          if (s.treeModel?.isSearchOpen()) s.treeModel.closeSearch();
        }
        // Hand focus to the review pane so the tree or a field stops swallowing keys.
        // The tree re-focuses its search box synchronously, so defer a frame.
        requestAnimationFrame(() => focusReview());
        clearWordFocus();
        s.escape();
        clearPending();
        return;
      }
      // The references overlay owns the keys while open, wherever focus sits.
      if (s.references.open) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'j' || e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) return s.moveReference(1);
        if (e.key === 'k' || e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) return s.moveReference(-1);
        if (e.key === 'Enter') return s.pickReference();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        const l = s.layout;
        if (e.shiftKey) s.setLayout({ panelVisible: !l.panelVisible });
        else s.setLayout({ treeVisible: !l.treeVisible });
        return;
      }
      // Editor convention for "focus the explorer"; shows the tree when it is hidden.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        focusTree();
        return;
      }
      if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'o' || e.key === 'i') && !isEditable(target)) {
        e.preventDefault();
        if (e.key === 'o') s.jumpBack();
        else s.jumpForward();
        return;
      }
      if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'd' || e.key === 'u') && !isEditable(target)) {
        e.preventDefault();
        const h = document.querySelector('.codeview')?.clientHeight ?? 800;
        const rows = Math.max(5, Math.floor(h / 2 / (1.25 * remPx()))); // 1.25rem: the diff row height
        s.moveCursorBy(e.key === 'd' ? rows : -rows);
        return;
      }
      // Arrow keys: up/down walk lines; left hands focus to the tree (whose own
      // arrows walk files); right comes back from the tree to the review pane.
      // Focus inside the tree's shadow root surfaces as the host element.
      if (document.activeElement?.tagName === 'FILE-TREE-CONTAINER') {
        if (e.key === 'ArrowRight' && !isEditable(target)) {
          e.preventDefault();
          e.stopPropagation(); // otherwise the tree moves focus to the next row afterwards
          focusReview();
        } else if (e.key === '/' && !isEditable(target)) {
          // The tree's own type-ahead opens its filter on letters only; `/` in the tree filters files, as it did from the diff.
          e.preventDefault();
          s.treeModel?.openSearch();
        }
        return; // the tree owns every other key while focused
      }
      if (isEditable(target) || e.metaKey || hasModifier(e)) return;
      if (s.modeMenuOpen && target?.closest('#mode-picker') && !/^[1-4]$/.test(e.key)) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        if (n > 0) s.moveCursorBy(dir * n);
        else s.moveCursor(dir);
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        focusTree();
        return;
      }
      if (s.helpOpen && e.key !== '?') {
        s.setHelpOpen(false);
        return;
      }
      if (s.modeMenuOpen && /^[1-4]$/.test(e.key)) {
        e.preventDefault();
        s.pickModeEntry(Number(e.key));
        return;
      }

      const prefix = pending.current?.key;
      clearPending();
      // A count starts with 1-9 (`0` alone is a motion) and grows with any digit.
      if (!prefix && /^[0-9]$/.test(e.key) && (typed || e.key !== '0')) {
        e.preventDefault();
        count.current = typed + e.key;
        return;
      }
      if (!prefix && PREFIXES.has(e.key)) {
        // `g` alone also has no action; wait for the second key, which the count outlives (`10gg`).
        count.current = typed;
        pending.current = { key: e.key, timer: setTimeout(clearPending, CHORD_MS) };
        return;
      }
      const chord = prefix ? prefix + e.key : e.key;
      const counted = n > 0 ? COUNTED[chord] : undefined;
      const action = KEYMAP[chord];
      // Unknown keys keep their browser behavior (Tab, Space, PageDown, F5, ...).
      if (!counted && !action) return;
      e.preventDefault();
      if (counted) counted(s, n);
      else action!(s);
    };
    // A key we acted on is ours alone: the viewer cancels its pending programmatic scroll on any
    // keydown reaching it, which would cancel the very jump the key requested.
    const onKey = (e: KeyboardEvent) => {
      dispatch(e);
      if (e.defaultPrevented) e.stopPropagation();
    };
    // The tree closes its search on Escape key-up and re-focuses its input; take focus back after that.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && realTarget(e)?.getAttribute('role') !== 'combobox') setTimeout(focusReview, 0);
    };
    // Capture phase: the tree stops propagation of keys it handles (arrows), and we
    // need ArrowRight to hand focus back. Editable targets are skipped early.
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('keyup', onKeyUp);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('keyup', onKeyUp);
      clearPending();
      count.current = '';
    };
  }, []);
}

/** Focus the file tree on the active file so its own arrow keys walk the files. */
function focusTree(): void {
  const s = useStore.getState();
  if (!s.layout.treeVisible) s.setLayout({ treeVisible: true });
  const model = s.treeModel;
  const host = document.querySelector<HTMLElement>('file-tree-container');
  requestAnimationFrame(() => {
    const path =
      s.activePath && model?.getItem(s.activePath) ? s.activePath : model?.focusNearestPath(s.activePath ?? null);
    if (path && model) model.focusPath(path);
    // The tree keeps one focusable row (tabindex=0); DOM focus must land on it for its arrow keys to work.
    const row =
      host?.shadowRoot?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]') ??
      host?.shadowRoot?.querySelector<HTMLElement>('[role="tree"]');
    (row ?? host)?.focus();
  });
}

/** Move keyboard focus to the review pane, so the vim keys reach the cursor instead of the tree or a field. */
export function focusReview(): void {
  (document.activeElement as HTMLElement | null)?.blur?.();
  document.querySelector<HTMLElement>('main[tabindex]')?.focus({ preventScroll: true });
}

async function copyComments(): Promise<void> {
  const s = useStore.getState();
  let text: string;
  try {
    text = await api.exportComments();
  } catch (e) {
    // A silent failure leaves the previous clipboard to be pasted into the agent.
    return s.report('Copying comments', e);
  }
  const ok = await copyText(text);
  s.flash(ok ? 'Copied all comments' : 'Clipboard blocked; use the panel buttons');
}
