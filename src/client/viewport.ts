// The layout and diff style a tab starts with, from `--viewport` or the window's shape.
import type { Viewport } from '@/shared/protocol.js';
import type { DiffStyle, LayoutState } from './store.js';
import type { ViewId } from './views/state.js';

type Width = Exclude<Viewport, 'auto'>;

/** Below this width-to-height ratio a window is narrow: one beside an editor, square or portrait. */
const NARROW_ASPECT = 1.2;

// A record, so the compiler names a view added without one.
const PANELS: Record<ViewId, null> = { diff: null, graph: null, tour: null };

/** How wide a window of `width` × `height` reads. */
export function windowWidth(width: number, height: number): Width {
  return width < height * NARROW_ASPECT ? 'narrow' : 'wide';
}

function currentWindowWidth(): Width {
  return typeof window === 'undefined' ? 'wide' : windowWidth(innerWidth, innerHeight);
}

/** The width to start from: the one `viewport` forces, else the window's while nothing is `saved`, else none. */
function startWidth(viewport: Viewport, saved: boolean): Width | null {
  if (viewport !== 'auto') return viewport;
  return saved ? null : currentWindowWidth();
}

/** The diff style to start with, given the reader's `saved` one. */
export function startDiffStyle(viewport: Viewport, saved: DiffStyle | null): DiffStyle {
  const width = startWidth(viewport, saved != null);
  if (width == null) return saved ?? 'split';
  return width === 'narrow' ? 'unified' : 'split';
}

/** The layout to start with, given the reader's `saved` one: a forced width keeps their panel sizes. */
export function startLayout(viewport: Viewport, saved: Partial<LayoutState> | null): LayoutState {
  const layout: LayoutState = {
    treeWidth: saved?.treeWidth ?? null,
    treeVisible: saved?.treeVisible ?? true,
    panels: saved?.panels ?? {},
  };
  const width = startWidth(viewport, saved != null);
  if (width == null) return layout;
  const visible = width === 'wide';
  const panels = Object.fromEntries(
    Object.keys(PANELS).map((view) => [view, { width: layout.panels[view as ViewId]?.width ?? null, visible }]),
  );
  return { ...layout, treeVisible: visible, panels };
}
