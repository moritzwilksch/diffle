import type { LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';
import { create } from 'zustand';
import { type LayoutState, type ReviewState, useStore, type ViewPlace } from '@/client/store.js';

export type ViewId = 'diff' | 'graph';

type HelpRow = [keys: string, action: string];
export type HelpSection = { title: string; rows: HelpRow[] };

/**
 * A view of the review: what it shows in the main pane and in the side panel, and how it takes part
 * in the keys, the tree and the jump list while it is shown. The diff is the base the others cover:
 * jumps land in it, and leaving another view returns to it.
 */
export interface ViewDef {
  id: ViewId;
  label: string;
  icon: LucideIcon;
  /** The switch's tooltip, with the key that shows the view. */
  title: string;
  Main: ComponentType;
  Side: ComponentType;
  /** Header controls that act on this view alone. */
  Controls?: ComponentType;
  /** Names the side panel, for its toggle. */
  panelLabel: string;
  /**
   * The shortcuts that work while the view shows, one array of sections per help column. Every key
   * appears once; each row renders on one line, so descriptions stay short.
   */
  help: HelpSection[][];
  /** The side panel's width until the reader drags it, as a CSS length. */
  panelWidth: string;
  /** Why the view cannot be shown now, or null. */
  blocked?(s: ReviewState): string | null;
  enter?(): void;
  leave?(): void;
  /** Where the reader is in the view, for the jump list; Ctrl+o after a jump into the diff restores it. */
  place?(): ViewPlace;
  /** The view's own keys; true when `e` was one. Unless `passes` holds it, any other key does nothing. */
  keys?(e: KeyboardEvent): boolean;
  passes?: ReadonlySet<string>;
  /** Escape within the view; true when it used the key. `inField` when a text field has focus. */
  escape?(inField: boolean): boolean;
  /** Ctrl/⌘+F: the view's own find, in place of the browser's. */
  find?(): void;
  /** The reader picked `path` in the file tree again while the view shows. */
  pickFile?(path: string): void;
}

interface ViewsState {
  active: ViewId;
  /** Shown at least once: a view stays mounted under the active one, so it keeps its scroll, pan and zoom. */
  mounted: ViewId[];
}

export const useViews = create<ViewsState>(() => ({
  active: 'diff',
  mounted: ['diff'],
}));

const defs = new Map<ViewId, ViewDef>();

/** Registers the views, in the switch's order. The app does once, at startup, before anything renders. */
export function defineViews(views: ViewDef[]): void {
  for (const view of views) defs.set(view.id, view);
}

export function listViews(): ViewDef[] {
  return [...defs.values()];
}

function viewOf(id: ViewId): ViewDef {
  const view = defs.get(id);
  if (!view) throw new Error(`view ${id} is not defined`);
  return view;
}

export function activeView(): ViewDef {
  return viewOf(useViews.getState().active);
}

/** The shown view, re-rendering when another shows. */
export function useActiveView(): ViewDef {
  return useViews((s) => viewOf(s.active));
}

/** Shows `id`, or says why it cannot be shown. */
export function showView(id: ViewId): void {
  const { active, mounted } = useViews.getState();
  if (id === active) return;
  const next = viewOf(id);
  const review = useStore.getState();
  const blocked = next.blocked?.(review);
  if (blocked) return review.flash(blocked);
  defs.get(active)?.leave?.();
  useViews.setState({
    active: id,
    mounted: mounted.includes(id) ? mounted : [...mounted, id],
  });
  next.enter?.();
}

/** Shows `id`, or the diff again when `id` already shows. */
export function toggleView(id: ViewId): void {
  showView(useViews.getState().active === id ? 'diff' : id);
}

const NO_PANEL = { width: null, visible: true };

export function panelOf(layout: LayoutState, view: ViewId): { width: number | null; visible: boolean } {
  return layout.panels[view] ?? NO_PANEL;
}

/** The page grid's columns: the tree, the main pane, and the side panel of `view`. */
export function gridColumns(layout: LayoutState, view: ViewId): string {
  const panel = panelOf(layout, view);
  const length = (px: number | null, fallback: string) => (px == null ? fallback : `${px}px`);
  return [
    layout.treeVisible ? `${length(layout.treeWidth, '17.5rem')} 4px` : '',
    'minmax(0, 1fr)',
    panel.visible ? `4px ${length(panel.width, defs.get(view)?.panelWidth ?? '21.25rem')}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}
