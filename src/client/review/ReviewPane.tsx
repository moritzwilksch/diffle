import type {
  CodeViewItem,
  CodeViewLineSelection,
  DiffLineAnnotation,
  DiffTokenEventBaseProps,
  FileDiffLoadedFiles,
  FileDiffMetadata,
  LineAnnotation,
  OnDiffLineClickProps,
  OnLineClickProps,
  TokenEventBase,
} from '@pierre/diffs';
import { CodeView, type CodeViewHandle } from '@pierre/diffs/react';
import { ArrowLeft, ChevronDown, ChevronRight, Download, FileText, MessageSquare, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { isPython, type ChangedFile, type CommentThread, type Side } from '../../shared/protocol.js';
import { FilePath } from '../FilePath.js';
import { lineBounds, sideOf } from '../comments/anchor.js';
import { SearchBar } from '../keyboard/SearchBar.js';
import { HoverTooltip, hoverControl } from '../lsp/HoverTooltip.js';
import { ReferencesList } from '../lsp/ReferencesList.js';
import { SymbolMenu } from '../lsp/SymbolMenu.js';
import { SymbolPicker } from '../lsp/SymbolPicker.js';
import { lspTarget, type TokenTarget } from '../lsp/target.js';
import {
  isCollapsed,
  itemDeps,
  itemId,
  itemVersion,
  orderedPaths,
  pathFromItemId,
  viewedState,
  visibleThreads,
  type ItemVersion,
} from '../model.js';
import { remPx } from '../scale.js';
import { SHIKI_THEMES } from '../theme.js';
import { useStore, type Draft, type Loaded, type ReviewState } from '../store.js';
import { rowOf } from './rows.js';
import { reviewGeometry } from './geometry.js';
import { onSelectionChanged, setViewer } from '../lsp/wordNav.js';
import { installSearchHighlights } from '../search/highlight.js';
import { CommentCard } from './CommentCard.js';
import { CommentComposer } from './CommentComposer.js';

export type Annot = { kind: 'thread'; thread: CommentThread } | { kind: 'draft' };

/** Where jump navigation parks the target line, as a fraction of the viewport height. */
const EYE_FRACTION = 0.5;

/**
 * Full contents for both sides of a patch-based diff, fetched when the user
 * expands context. The viewer asks only for modified and renamed files (added
 * and deleted diffs already carry their whole contents), so the new side must
 * exist; a missing old side is the pure-rename case the loader contract allows.
 */
async function loadDiffFiles(fileDiff: FileDiffMetadata): Promise<FileDiffLoadedFiles> {
  const newPath = fileDiff.name;
  const oldPath = fileDiff.prevName ?? newPath;
  const { loadFile } = useStore.getState();
  const [oldRes, newRes] = await Promise.all([
    loadFile(oldPath, 'old').catch(() => null),
    loadFile(newPath, 'new').catch(() => null),
  ]);
  if (!newRes) throw new Error(`cannot load ${newPath}`);
  const newFile = { name: newPath, contents: newRes.contents, cacheKey: `${newPath}@new@${Date.now()}` };
  if (!oldRes) return { oldFile: null, newFile };
  return { oldFile: { name: oldPath, contents: oldRes.contents, cacheKey: `${oldPath}@old@${Date.now()}` }, newFile };
}

/** Injected into the diff viewer's shadow DOM: make the file header a distinct band. */
const HEADER_CSS = `
[data-diffs-header] {
  --diffs-header-font-family: var(--mono);
  font-size: 0.75rem;
  background: var(--bg-2);
  /* The card's border carries the sides and top; the header only needs to separate itself from the code. */
  border-bottom: 1px solid var(--border);
  font-weight: 600;
}
/* The file under the reader's eyes: the tree's selected-row tint, so both panes point at it the same way. */
:host([data-active]) [data-diffs-header] {
  background: light-dark(color-mix(in lab, var(--accent) 12%, var(--bg)), color-mix(in lab, var(--accent) 15%, var(--bg)));
}
[data-diffs-header][data-sticky] { box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12); }
.lsp-hover { text-decoration: underline; cursor: pointer; }
.lsp-focus { outline: 1px solid var(--accent); outline-offset: 1px; border-radius: 3px; }
/* Word-level changes: the library's default tint sits too close to the line tint to pick out. */
:host {
  /* Pin the code canvas to our ground. Our palette is the same GitHub high-contrast theme, so this only
     guarantees the match for the dark panes, which share --bg where the theme would tint them. */
  --diffs-dark-bg: var(--bg);
  --diffs-light-bg: var(--bg);
  /* Dark keeps context rows on the same ground as the panes; light keeps the library's faint grey tint. */
  --diffs-bg-context-override: light-dark(color-mix(in lab, var(--diffs-bg) 98.5%, var(--diffs-mixer)), var(--bg));
  --diffs-bg-addition-emphasis-override: light-dark(rgb(from var(--diffs-addition-base) r g b / 0.32), rgb(from var(--diffs-addition-base) r g b / 0.4));
  --diffs-bg-deletion-emphasis-override: light-dark(rgb(from var(--diffs-deletion-base) r g b / 0.32), rgb(from var(--diffs-deletion-base) r g b / 0.4));
}
/* A comment anchored inside a hunk would otherwise cut the tinted block in two and read as two hunks. */
[data-line-type='change-addition'] + [data-line-annotation],
[data-line-type='change-addition'] + [data-gutter-buffer='annotation'] { --diffs-annotation-bg: var(--diffs-bg-addition); }
[data-line-type='change-deletion'] + [data-line-annotation],
[data-line-type='change-deletion'] + [data-gutter-buffer='annotation'] { --diffs-annotation-bg: var(--diffs-bg-deletion); }
/* Same for the gutter bar: the library only paints it on number cells, so a comment left a gap in it. Mirrors its 'bars' rules. */
[data-indicators='bars'] :is([data-line-type='change-addition'], [data-line-type='change-deletion']) + [data-gutter-buffer='annotation']::after {
  content: ''; position: absolute; top: 0; left: 0; width: 4px; height: 100%; user-select: none; contain: strict;
}
[data-indicators='bars'] [data-line-type='change-addition'] + [data-gutter-buffer='annotation']::after { background-color: var(--diffs-addition-base); }
[data-indicators='bars'] [data-line-type='change-deletion'] + [data-gutter-buffer='annotation']::after {
  background-image: linear-gradient(0deg, var(--diffs-bg-deletion) 50%, var(--diffs-deletion-base) 50%);
  background-repeat: repeat;
  background-size: 2px 2px;
  background-size: calc(1lh / round(1lh / 2px)) calc(1lh / round(1lh / 2px));
}
/* Collapsed-context bars run edge to edge: inset rounded pills next to a full-width file header read as misaligned. */
[data-separator='line-info'] [data-separator-wrapper] { padding-inline: 0 !important; margin-inline: 0 !important; }
[data-separator='line-info'] :is([data-separator-wrapper], [data-separator-content], [data-expand-up], [data-expand-down], [data-expand-both]) { border-radius: 0 !important; }
::highlight(diffle-search) { background: var(--search-match); }
::highlight(diffle-search-current) { background: var(--search-current); color: var(--search-current-fg); }
`;

/**
 * Token under the pointer → LSP target. Diff tokens carry a side; file items are new-side only.
 * A context line is the same text on both sides, so its old-side column resolves to the new-side line.
 */
function targetOf(
  props: TokenEventBase | DiffTokenEventBaseProps,
  itemId: string,
  clientX?: number,
): TokenTarget | null {
  const path = pathFromItemId(itemId);
  if (!isPython(path)) return null;
  // A highlighter token can span several names (`a.b.c`, or a whole unhighlighted line); the pointer picks one.
  const word = clientX == null ? null : wordAtPoint(props.tokenElement, clientX);
  if (clientX != null && !word) return null;
  let side: Side = 'side' in props && props.side === 'deletions' ? 'old' : 'new';
  let line = props.lineNumber;
  if (side === 'old') {
    const row = props.tokenElement.closest<HTMLElement>('[data-line]');
    const alt = row?.dataset.lineType?.startsWith('context') ? Number(row.dataset.altLine) : NaN;
    if (Number.isFinite(alt)) {
      side = 'new';
      line = alt;
    }
  }
  return word
    ? { path, side, line, col: props.lineCharStart + word.start, text: word.text }
    : { path, side, line, col: props.lineCharStart, text: props.tokenText };
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** The identifier under `clientX` inside a token span: its text and its offset within the token, or null on punctuation or space. */
function wordAtPoint(el: HTMLElement, clientX: number): { start: number; text: string } | null {
  const node = el.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE || el.childNodes.length !== 1) return null;
  const text = node.textContent ?? '';
  const range = document.createRange();
  let at = -1;
  for (let i = 0; i < text.length; i++) {
    range.setStart(node, i);
    range.setEnd(node, i + 1);
    const r = range.getBoundingClientRect();
    if (clientX >= r.left && clientX <= r.right) {
      at = i;
      break;
    }
  }
  if (at === -1 || !WORD_CHAR.test(text[at]!)) return null;
  let start = at;
  while (start > 0 && WORD_CHAR.test(text[start - 1]!)) start--;
  let end = at + 1;
  while (end < text.length && WORD_CHAR.test(text[end]!)) end++;
  return { start, text: text.slice(start, end) };
}

/** Underline the hovered symbol while a modifier is held, like an editor's ctrl-hover. */
function markHover(el: HTMLElement, on: boolean): void {
  el.classList.toggle('lsp-hover', on);
}

const codeViewOptions = {
  theme: SHIKI_THEMES,
  loadDiffFiles,
  stickyHeaders: true,
  enableLineSelection: true,
  // Token hit-testing (data-char spans); also set on the worker pool in main.tsx, whose options win when the pool renders.
  useTokenTransformer: true,
  lineHoverHighlight: 'number',
  overflow: 'wrap',
} as const;

const LOADING: Loaded = { kind: 'loading' };

export function ReviewPane() {
  const rem = remPx();
  const geometry = useMemo(() => reviewGeometry(rem), [rem]);
  const snapshot = useStore((s) => s.snapshot);
  const error = useStore((s) => s.error);
  const loaded = useStore((s) => s.loaded);
  const gens = useStore((s) => s.gens);
  const fileView = useStore((s) => s.fileView);
  const threads = useStore((s) => s.threads);
  const showResolved = useStore((s) => s.showResolved);
  const replyTo = useStore((s) => s.replyTo);
  const editingId = useStore((s) => s.editingId);
  const draft = useStore((s) => s.draft);
  const collapsed = useStore((s) => s.collapsed);
  const viewed = useStore((s) => s.viewed);
  const config = useStore((s) => s.config);
  const selection = useStore((s) => s.selection);
  const setSelection = useStore((s) => s.setSelection);
  const openDraft = useStore((s) => s.openDraft);
  const goToDefinition = useStore((s) => s.goToDefinition);
  const openSymbolMenu = useStore((s) => s.openSymbolMenu);
  const scrollTarget = useStore((s) => s.scrollTarget);
  const reveal = useStore((s) => s.reveal);
  const setActivePath = useStore((s) => s.setActivePath);
  const viewerRef = useRef<CodeViewHandle<Annot> | null>(null);
  const theme = useStore((s) => s.theme);
  const diffStyle = useStore((s) => s.diffStyle);

  // CodeView re-renders an item only when its version changes, so each path's version is derived
  // here from what the item paints (its threads, draft, composers, collapsed state); no manual bump.
  const versions = useRef(new Map<string, ItemVersion>());
  const items = useMemo<CodeViewItem<Annot>[]>(() => {
    if (!snapshot) return [];
    const byPath = new Map(snapshot.changed.map((f) => [f.path, f]));
    const state = { collapsed, viewed, config, snapshot };
    const threadsByPath = new Map<string, CommentThread[]>();
    for (const t of visibleThreads({ threads, showResolved })) {
      const list = threadsByPath.get(t.anchor.path);
      if (list) list.push(t);
      else threadsByPath.set(t.anchor.path, [t]);
    }
    const versionOf = (path: string, mine: CommentThread[], isCollapsed: boolean) => {
      const v = itemVersion(
        versions.current.get(path),
        itemDeps({ draft, replyTo, editingId }, path, mine, isCollapsed),
      );
      versions.current.set(path, v);
      return v.version;
    };
    if (fileView) {
      const { path, item } = fileView;
      const mine = threadsByPath.get(path) ?? [];
      const one =
        item && toItem(path, item, undefined, mine, draft, versionOf(path, mine, false), gens[path] ?? 0, false);
      return one ? [one] : [];
    }
    const out: CodeViewItem<Annot>[] = [];
    for (const path of orderedPaths(snapshot)) {
      // A file whose patch has not arrived is a header-only placeholder, so the pane and the nav model
      // hold the same items and a jump onto it has somewhere to land.
      const l = loaded[path] ?? LOADING;
      const mine = threadsByPath.get(path) ?? [];
      const folded = isCollapsed(state, path);
      const item = toItem(
        path,
        l,
        byPath.get(path),
        mine,
        draft,
        versionOf(path, mine, folded),
        gens[path] ?? 0,
        folded,
      );
      if (item) out.push(item);
    }
    return out;
  }, [snapshot, loaded, gens, fileView, threads, showResolved, replyTo, editingId, draft, collapsed, viewed, config]);

  // The scroller is state, not a ref: CodeView mounts after the empty / error branches and remounts per
  // theme, and the effects that listen to it must re-run for each element, not only when the snapshot appears.
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const attachScroller = useCallback((el: HTMLDivElement | null) => {
    containerRef.current = el;
    setScroller(el);
  }, []);

  // Swapping the file view for the diff list (or back) makes the viewer drop its selection and
  // report null before the controlled selection is re-applied. That null is not the user's; skip it.
  const swapping = useRef(false);
  const prevView = useRef(fileView);
  if ((prevView.current == null) !== (fileView == null) || prevView.current?.path !== fileView?.path) {
    prevView.current = fileView;
    swapping.current = true;
  }
  useEffect(() => {
    swapping.current = false;
  }, [items]);

  // Word navigation (w / b) reads tokens from the rendered DOM through the viewer handle.
  useEffect(() => {
    setViewer(() => viewerRef.current as CodeViewHandle<unknown> | null);
    return () => setViewer(() => null);
  }, []);
  // Search-match highlights read the same rendered DOM; the scroller drives re-paints as rows virtualize.
  useEffect(() => {
    if (!scroller) return;
    return installSearchHighlights(() => viewerRef.current as CodeViewHandle<unknown> | null, scroller);
  }, [scroller]);
  useEffect(() => {
    onSelectionChanged();
  }, [selection]);
  // The tree's selected row mirrors the file under the reader's eyes, so wheel scrolling must move it too.
  // Not while a line or hunk is focused: the cursor names the file then, wherever the reader has scrolled
  // to, and letting the gaze point override it made the tree flip back and forth (issue #10). Without a
  // cursor, the active file wins while it is on screen (J onto a collapsed header pins it at the top with
  // a stack of other headers below, and the reader is looking at it, not at whichever header happens to
  // sit at the gaze point); otherwise the bottom-most file that has reached the gaze point, which is
  // where every jump lands its line.
  // Set while a jump is landing: the scroll events it produces are not the reader's, and the store
  // has already named the active file.
  const jumping = useRef(false);
  useEffect(() => {
    if (!scroller) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      if (jumping.current || useStore.getState().selection) return;
      const items = viewerRef.current?.getInstance()?.getRenderedItems() ?? [];
      const box = scroller.getBoundingClientRect();
      const header = geometry.itemMetrics.diffHeaderHeight;
      const eye = box.top + box.height * EYE_FRACTION;
      const inView = items
        .map((r) => ({ id: r.id, rect: r.element.getBoundingClientRect() }))
        .filter((r) => r.rect.bottom > box.top + header + 1 && r.rect.top < box.bottom && r.rect.height > 0);
      if (inView.length === 0) return;
      const s = useStore.getState();
      const pick =
        inView.find((r) => pathFromItemId(r.id) === s.activePath) ??
        inView.filter((r) => r.rect.top <= eye).sort((a, b) => b.rect.top - a.rect.top)[0] ??
        inView[0]!;
      const path = pathFromItemId(pick.id);
      if (path !== s.activePath) s.setActivePath(path);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scroller, geometry]);

  // Reveal a line hidden in collapsed context: bring the item into the virtual window,
  // ask its instance to expand around the line, then center it.
  useEffect(() => {
    if (!reveal || !viewerRef.current) return;
    const handle = viewerRef.current;
    handle.scrollTo({ type: 'item', id: reveal.id, align: 'start', behavior: 'instant' });
    let tries = 0;
    let cancelled = false;
    const attempt = () => {
      if (cancelled) return;
      const rendered = handle
        .getInstance()
        ?.getRenderedItems()
        .find((r) => r.id === reveal.id);
      if (rendered?.type === 'diff') {
        rendered.instance.revealLine(reveal.line);
        // Tell the cursor model which lines are now on screen, so j / k walk them instead of skipping to the next hunk.
        const inst = rendered.instance;
        let lo = reveal.line;
        let hi = reveal.line;
        while (lo > 1 && reveal.line - lo < 10_000 && inst.isLineRenderable(lo - 1)) lo--;
        while (hi - lo < 10_000 && inst.isLineRenderable(hi + 1)) hi++;
        useStore.getState().addRevealed(reveal.id, lo, hi);
        // Let the expansion render, then center the line.
        setTimeout(() => {
          if (cancelled) return;
          useStore.setState((s) => ({
            scrollTarget: {
              id: reveal.id,
              line: reveal.line,
              side: 'new',
              align: 'eye',
              nonce: (s.scrollTarget?.nonce ?? 0) + 1,
            },
          }));
        }, 30);
        return;
      }
      if (tries++ < 40) setTimeout(attempt, 50);
    };
    attempt();
    return () => {
      cancelled = true;
    };
  }, [reveal]);
  // The scroll request for a target: eye/top/bottom pin the line at a fixed height ('start' plus an
  // offset below the sticky header); the landing in the effect below measures the row and makes it exact.
  const scrollPlan = useCallback(
    (scrollTarget: NonNullable<ReviewState['scrollTarget']>) => {
      const requested = scrollTarget.align ?? 'center';
      const eye = requested === 'eye' || requested === 'top' || requested === 'bottom';
      const height = containerRef.current?.clientHeight ?? 800;
      const header = geometry.itemMetrics.diffHeaderHeight;
      const edge = geometry.edge;
      const offset =
        requested === 'eye'
          ? height * EYE_FRACTION - header
          : requested === 'top'
            ? edge
            : requested === 'bottom'
              ? Math.max(edge, height - header - edge - geometry.itemMetrics.lineHeight)
              : 0;
      const align = eye ? 'start' : requested;
      const target = scrollTarget.line
        ? {
            type: 'line' as const,
            id: scrollTarget.id,
            lineNumber: scrollTarget.line,
            side: scrollTarget.side === 'old' ? ('deletions' as const) : ('additions' as const),
            align,
            offset,
            // Jumps are instant so the target lands exactly where expected; no mid-animation drift.
            behavior: eye ? ('instant' as const) : undefined,
          }
        : { type: 'item' as const, id: scrollTarget.id, align: 'start' as const, behavior: 'instant' as const };
      return { eye, offset, header, target };
    },
    [geometry],
  );
  const renderedRow = (scrollTarget: NonNullable<ReviewState['scrollTarget']>) => {
    const rendered = viewerRef.current
      ?.getInstance()
      ?.getRenderedItems()
      .find((r) => r.id === scrollTarget.id);
    const root = rendered?.element.shadowRoot ?? rendered?.element;
    return root && scrollTarget.line ? rowOf(root, scrollTarget.line, scrollTarget.side ?? 'new') : null;
  };
  // A view swap (Ctrl+o back from the whole file, F into it) or a theme remount hands the viewer new
  // items whose rows have no layout yet, so the jump can only land after paint and the first frame
  // would show the old scroll position. Hide the pane for exactly those frames; the effect below
  // shows it once the row is placed. Ordinary jumps never pass through here. Refs are updated in
  // the effect, not during render, since React may render a store update more than once.
  const prevTheme = useRef(theme);
  const lastTarget = useRef(scrollTarget);
  useLayoutEffect(() => {
    const remounted = swapping.current || prevTheme.current !== theme;
    const fresh = scrollTarget !== lastTarget.current;
    prevTheme.current = theme;
    lastTarget.current = scrollTarget;
    const pane = containerRef.current;
    if (!pane) return;
    pane.style.visibility = remounted && fresh && scrollTarget?.line && !renderedRow(scrollTarget) ? 'hidden' : '';
  }, [scrollTarget, theme]);
  // A jump lands in one paint. The viewer is asked to scroll, then to render synchronously: that frame
  // draws the target rows, measures them (wrapped lines included), re-resolves the destination and moves
  // the scroller, all before the browser paints. The row is then measured against the gaze point and the
  // request re-issued with the residue folded into its offset, still synchronously, so the reader sees a
  // single move. Only content that resizes after paint (a comment card mounting, a late image) can shift
  // the row afterwards; the deferred checks catch that without a visible hunt.
  useEffect(() => {
    if (!scrollTarget || !viewerRef.current) return;
    const { eye, offset, header, target } = scrollPlan(scrollTarget);
    const pinned = eye && scrollTarget.line != null;
    jumping.current = true;
    let settled: ReturnType<typeof setTimeout> | undefined;
    // The scroll events of a landing arrive after it, on their own frame; give them one before the
    // tree follows wheel scrolling again.
    const release = () => {
      settled = setTimeout(() => {
        jumping.current = false;
      }, 150);
    };
    // Lifts the hide from the layout effect above once the row is placed or the jump is given up.
    const show = () => {
      if (containerRef.current) containerRef.current.style.visibility = '';
    };
    // How far the landed element sits below its mark, NaN while it is not rendered: the row below the
    // gaze point for a line jump, the file card below the pane's top padding for an item jump (J / K),
    // so a header always stops at the same pixel whatever the estimates above it were.
    const drift = () => {
      const scroller = containerRef.current;
      if (!scroller) return NaN;
      const base = scroller.getBoundingClientRect().top;
      if (target.type === 'item') {
        const card = viewerRef.current
          ?.getInstance()
          ?.getRenderedItems()
          .find((r) => r.id === scrollTarget.id)?.element;
        return card ? card.getBoundingClientRect().top - (base + geometry.layout.paddingTop) : NaN;
      }
      const top = renderedRow(scrollTarget)?.getBoundingClientRect().top ?? NaN;
      return top - (base + offset + header);
    };
    // Jumps that hold their mark to the pixel: line jumps at the gaze point and item jumps at the top.
    const exact = pinned || target.type === 'item';
    // How far a 'nearest' row pokes out of the pane: past its bottom edge, or under the sticky header.
    // The viewer decides "already visible" from its own bookkeeping, and when that is off the cursor
    // walks out of view and stays there (issue #8); the rendered row is the truth, so measure it.
    const overflow = () => {
      const scroller = containerRef.current;
      const row = renderedRow(scrollTarget);
      if (!scroller || !row) return NaN;
      const box = scroller.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      if (r.top < box.top + header) return r.top - (box.top + header);
      if (r.bottom > box.bottom) return r.bottom - box.bottom;
      return 0;
    };
    // One synchronous landing; false when the item is not in the viewer yet.
    const land = (): boolean => {
      const viewer = viewerRef.current;
      const instance = viewer?.getInstance();
      if (!viewer || !instance || !viewer.getItem(scrollTarget.id)) return false;
      viewer.scrollTo(target);
      instance.render(true);
      if (!exact) {
        const d = target.type === 'line' ? overflow() : NaN;
        if (!Number.isNaN(d) && Math.abs(d) > 1 && containerRef.current) {
          containerRef.current.scrollTop += d;
          instance.render(true);
        }
        return true;
      }
      for (let i = 0; i < 4; i++) {
        const d = drift();
        if (Number.isNaN(d)) {
          viewer.scrollTo(target);
          instance.render(true);
          continue;
        }
        if (Math.abs(d) <= 1) break;
        viewer.scrollTo({ ...target, offset: (target.offset ?? 0) - d });
        instance.render(true);
      }
      return true;
    };
    let cancelled = false;
    let checks = 0;
    const verify = () => {
      setTimeout(() => {
        if (cancelled) return;
        const d = drift();
        if (!Number.isNaN(d) && Math.abs(d) > 1 && containerRef.current) containerRef.current.scrollTop += d;
        if (checks++ < 2) verify();
      }, 100);
    };
    // Items may still be loading; retry briefly.
    let tries = 0;
    const attempt = () => {
      if (cancelled) return;
      if (!land()) {
        if (tries++ < 20) setTimeout(attempt, 100);
        else {
          show();
          release();
        }
        return;
      }
      show();
      release();
      if (exact) verify();
    };
    attempt();
    return () => {
      cancelled = true;
      if (settled) clearTimeout(settled);
    };
  }, [scrollTarget, geometry, scrollPlan]);

  const onSelectedLinesChange = useCallback(
    (sel: CodeViewLineSelection | null) => {
      if (sel == null && swapping.current) return;
      setSelection(sel);
      if (sel) setActivePath(pathFromItemId(sel.id));
    },
    [setSelection, setActivePath],
  );

  const options = useMemo(
    () => ({
      ...codeViewOptions,
      unsafeCSS: HEADER_CSS + geometry.css,
      layout: geometry.layout,
      itemMetrics: geometry.itemMetrics,
      hunkSeparators: 'line-info' as const,
      themeType: theme,
      diffStyle,
      onLineSelectionEnd: () => {
        const sel = viewerRef.current?.getSelectedLines();
        if (sel) void openDraft(sel);
      },
      onTokenEnter: (
        props: TokenEventBase | DiffTokenEventBaseProps,
        event: PointerEvent,
        ctx: { item: { id: string } },
      ) => {
        // The word under the pointer when it entered; the whole token if the pointer sits on punctuation.
        const t = targetOf(props, ctx.item.id, event.clientX) ?? targetOf(props, ctx.item.id);
        lspTarget.set(t, props.tokenElement);
        if (t) hoverControl.enter(t, props.tokenElement);
        else hoverControl.leave();
        if (t && (event.ctrlKey || event.metaKey)) markHover(props.tokenElement, true);
      },
      onTokenLeave: (props: TokenEventBase | DiffTokenEventBaseProps) => {
        lspTarget.set(null);
        hoverControl.leave();
        markHover(props.tokenElement, false);
      },
      // Clicking a line's content puts the cursor there (the number column starts a range selection instead).
      // Fires after onTokenClick on the same click, so it must not close the popover that click opened.
      onLineClick: (props: OnLineClickProps | OnDiffLineClickProps, ctx: { item: { id: string } }) => {
        if (props.numberColumn) return;
        const side = 'annotationSide' in props ? props.annotationSide : 'additions';
        const range = { start: props.lineNumber, side, end: props.lineNumber, endSide: side };
        setSelection({ id: ctx.item.id, range });
        setActivePath(pathFromItemId(ctx.item.id));
      },
      // A plain click on a symbol opens the action popover; ⌘/Ctrl+click jumps straight to the definition.
      onTokenClick: (
        props: TokenEventBase | DiffTokenEventBaseProps,
        event: MouseEvent,
        ctx: { item: { id: string } },
      ) => {
        const target = targetOf(props, ctx.item.id, event.clientX);
        if (!target) return;
        markHover(props.tokenElement, false);
        hoverControl.cancel();
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          void goToDefinition(target);
          return;
        }
        void openSymbolMenu(target, event.clientX, event.clientY);
      },
    }),
    [openDraft, goToDefinition, openSymbolMenu, setSelection, setActivePath, theme, diffStyle, geometry],
  );

  const renderAnnotation = useCallback((annotation: LineAnnotation<Annot> | DiffLineAnnotation<Annot>) => {
    const meta = annotation.metadata;
    if (meta.kind === 'draft') {
      const d = useStore.getState().draft;
      return <CommentComposer lines={d ? describeSelection(d) : ''} />;
    }
    return <CommentCard thread={meta.thread} />;
  }, []);

  const renderHeaderMetadata = useCallback(
    (item: CodeViewItem<Annot>) => <FileHeaderMeta path={pathFromItemId(item.id)} />,
    [],
  );

  if (error)
    return (
      <main className="review">
        <div className="banner error">{error}</div>
      </main>
    );
  if (!snapshot)
    return (
      <main className="review">
        <div className="empty">Loading snapshot…</div>
      </main>
    );
  if (snapshot.changed.length === 0 && !fileView) {
    return (
      <main className="review">
        <div className="empty">
          No changes for <code>{snapshot.mode.label}</code>. Open any file from the tree to comment on it.
        </div>
      </main>
    );
  }

  return (
    <main className="review" tabIndex={-1}>
      <SearchBar />
      <SymbolPicker />
      <SymbolMenu />
      <HoverTooltip />
      <ReferencesList />
      {fileView && <FileViewBar path={fileView.path} />}
      {fileView
        ? !fileView.item && <div className="banner">Loading {fileView.path}…</div>
        : snapshot.changed.some((f) => !loaded[f.path]) && <div className="banner">Loading diffs…</div>}
      <CodeView<Annot>
        key={theme}
        ref={viewerRef}
        containerRef={attachScroller}
        className="codeview"
        items={items}
        options={options}
        selectedLines={selection}
        onSelectedLinesChange={onSelectedLinesChange}
        renderAnnotation={renderAnnotation}
        renderHeaderMetadata={renderHeaderMetadata}
      />
    </main>
  );
}

/** The file view's header: the way back to the diff list. */
function FileViewBar({ path }: { path: string }) {
  const closeFullFile = useStore((s) => s.closeFullFile);
  const file = useStore((s) => s.snapshot?.changed.find((f) => f.path === path));
  return (
    <div className="fileview-bar">
      <button className="ghost" onClick={closeFullFile} title="Back to the diff (Ctrl+o)">
        <ArrowLeft size="0.875rem" /> Back to diff
      </button>
      <span className="path">
        <FilePath path={path} />
      </span>
      {file && (
        <span className="file-meta">
          {file.additions > 0 && <span className="add">+{file.additions}</span>}
          {file.deletions > 0 && <span className="del">−{file.deletions}</span>}
        </span>
      )}
      <kbd>Ctrl+o</kbd>
    </div>
  );
}

function toItem(
  path: string,
  loaded: Loaded,
  changed: ChangedFile | undefined,
  mine: CommentThread[],
  draft: Draft | null,
  version: number,
  gen: number,
  collapsed: boolean,
): CodeViewItem<Annot> | null {
  const id = itemId(changed != null, path, gen);
  if (changed) {
    const annotations: DiffLineAnnotation<Annot>[] = mine.map((t) => ({
      side: t.anchor.side === 'old' ? 'deletions' : 'additions',
      lineNumber: t.anchor.endLine,
      metadata: { kind: 'thread', thread: t },
    }));
    if (draft?.path === path) {
      const { endLine } = lineBounds(draft.selection);
      const s = draft.selection.range.endSide ?? draft.selection.range.side ?? 'additions';
      annotations.push({ side: s, lineNumber: endLine, metadata: { kind: 'draft' } });
    }
    if (loaded.kind === 'diff') return { id, type: 'diff', fileDiff: loaded.fileDiff, annotations, version, collapsed };
    // Binary, oversized or failed: header-only placeholder via an empty file item under the diff id.
    const note =
      loaded.kind === 'oversized'
        ? `// ${loaded.lines.toLocaleString()} changed lines: not loaded. Press zo or the header's load button to load the diff.`
        : loaded.kind === 'error'
          ? `// ${loaded.message}`
          : loaded.kind === 'loading'
            ? '// loading…'
            : '';
    return {
      id,
      type: 'file',
      file: { name: path, contents: note },
      version,
      collapsed: loaded.kind === 'binary' || collapsed,
    };
  }
  // The file view shows the new side whole: only new-side threads have a line to sit on.
  if (loaded.kind !== 'file') {
    const note = loaded.kind === 'binary' ? '// binary file' : loaded.kind === 'error' ? `// ${loaded.message}` : '';
    return { id, type: 'file', file: { name: path, contents: note }, version, collapsed };
  }
  const annotations: LineAnnotation<Annot>[] = mine
    .filter((t) => t.anchor.side !== 'old')
    .map((t) => ({ lineNumber: t.anchor.endLine, metadata: { kind: 'thread', thread: t } }));
  if (draft?.path === path && sideOf(draft.selection) === 'new') {
    annotations.push({ lineNumber: lineBounds(draft.selection).endLine, metadata: { kind: 'draft' } });
  }
  return { id, type: 'file', file: loaded.file, annotations, version, collapsed };
}

function describeSelection(d: Draft): string {
  const { startLine, endLine } = lineBounds(d.selection);
  const side = sideOf(d.selection) === 'old' ? 'removed ' : '';
  return `${side}L${startLine}${endLine !== startLine ? `–${endLine}` : ''}`;
}

/** The viewer element hosting `el`: its shadow root's host, or the nearest ancestor that owns a shadow root. */
function hostOf(el: HTMLElement): HTMLElement | null {
  const root = el.getRootNode();
  if (root instanceof ShadowRoot) return root.host as HTMLElement;
  for (let p = el.parentElement; p; p = p.parentElement) if (p.shadowRoot) return p;
  return null;
}

function FileHeaderMeta({ path }: { path: string }) {
  const file = useStore((s) => s.snapshot?.changed.find((f) => f.path === path));
  const active = useStore((s) => s.activePath === path);
  const ref = useRef<HTMLSpanElement | null>(null);
  // The header lives in the viewer's shadow DOM; flag its host so the injected CSS can tint the active file.
  useEffect(() => {
    const host = ref.current && hostOf(ref.current);
    if (!host) return;
    host.toggleAttribute('data-active', active);
    return () => host.removeAttribute('data-active');
  }, [active]);
  const vs = useStore((s) => (file ? viewedState(s, file) : 'unviewed'));
  const setViewed = useStore((s) => s.setViewed);
  const toggleCollapsed = useStore((s) => s.toggleCollapsed);
  const count = useStore((s) => s.threads.filter((t) => t.anchor.path === path && !t.resolved).length);
  const collapsedNow = useStore((s) => isCollapsed(s, path));
  const full = useStore((s) => s.fileView?.path === path);
  const openFullFile = useStore((s) => s.openFullFile);
  const oversized = useStore((s) => s.loaded[path]?.kind === 'oversized');
  const loadPatch = useStore((s) => s.loadPatch);
  return (
    <span ref={ref} className="file-meta" onClick={(e) => e.stopPropagation()}>
      {count > 0 && (
        <span className="badge">
          <MessageSquare size="0.75rem" /> {count}
        </span>
      )}
      {file?.generated && (
        <span className="badge generated" title="Detected as generated: starts collapsed and ranks low">
          generated
        </span>
      )}
      {file?.submodule && (
        <span className="badge submodule" title="Submodule: only the recorded commit changes">
          submodule
        </span>
      )}
      {oversized && (
        <button className="ghost" onClick={() => void loadPatch(path)} title="Large diff, not loaded yet (zo)">
          <Download size="0.875rem" /> Load diff
        </button>
      )}
      {file && vs === 'restale' && (
        <span className="badge restale" title="You marked this viewed, then its contents changed">
          <RefreshCw size="0.75rem" /> changed since viewed
        </span>
      )}
      {/* In the file view the bar above already carries the way back, so the header offers no second button. */}
      {!full && (!file || (!file.binary && !file.submodule && file.status !== 'D')) && (
        <button className="ghost icon" onClick={() => void openFullFile(path)} title="View full file (F)">
          <FileText size="0.875rem" />
        </button>
      )}
      {file && !full && (
        <>
          <label
            title={vs === 'restale' ? 'Mark viewed again (collapses the file)' : 'Mark as viewed (collapses the file)'}
          >
            <input type="checkbox" checked={vs === 'viewed'} onChange={(e) => void setViewed(path, e.target.checked)} />
            Viewed
          </label>
        </>
      )}
      <button className="ghost icon" onClick={() => toggleCollapsed(path)} title="Collapse / expand">
        {collapsedNow ? <ChevronRight size="0.875rem" /> : <ChevronDown size="0.875rem" />}
      </button>
    </span>
  );
}
