// Injected into the tree's shadow root. Parts are flex items, so spacing is a gap (leading spaces
// would collapse). `--lane-edge` is how far the lanes stand from the pane's edge, in both modes:
// the library's own padding left them ~20px short of the divider.
//
// With `data-hscroll` on the host a name is never cut: the list grows to its widest row and the
// pane scrolls sideways. The decoration and git lanes pin to the pane's right edge, each with the
// row's opaque background to hide the names passing under it, so the viewed marks stay in one
// column within reach. Without it the tree ellipsizes names as it ships.
export const TREE_CSS = `
[data-file-tree-virtualized-scroll] { padding-right: 0; }
[data-type="item"] { --lane-edge: 0.375rem; padding-right: calc(var(--lane-edge) - var(--trees-item-margin-x)); }
[data-item-section="decoration"] { flex: 1 0 auto; overflow: visible; }
[data-item-section="decoration"] > span { gap: 0.375rem; overflow: visible; font-variant-numeric: tabular-nums; }
[data-item-section="decoration"] > span > span:last-child { min-width: 1ch; text-align: center; }
/* The tree shows a name's ellipsis once a hidden wrapping copy makes its cell taller than 1lh. At a
 * fractional browser zoom (110%) fixed-point rounding leaves every cell a hair taller, and the marker
 * then paints over names that fit (pierrecomputer/pierre#816). A wrapped copy is at least 2lh tall. */
@container measure (height < 1.5lh) { [data-truncate-marker] { opacity: 0; } }
/* The library butts the search box against the toolbar above; give it the toolbar's own vertical rhythm. */
[data-file-tree-search-container] { padding-top: 0.5rem; }
:host([data-search-empty]) [data-file-tree-virtualized-scroll] { display: none; }

:host([data-hscroll]) {
  /* A swipe past either end must not become the browser's back gesture. */
  [data-file-tree-virtualized-scroll] { overscroll-behavior-x: contain; }
  [data-file-tree-virtualized-list] { width: max-content; min-width: 100%; }
  [data-type="item"] {
    --lane-gutter: var(--trees-scrollbar-gutter-measured, var(--trees-scrollbar-gutter));
    /* A sticky offset counts from the scroll box's outer edge, scrollbar gutter included. */
    --lane-pin: calc(var(--lane-edge) + var(--lane-gutter));
    overflow: clip;
  }
  /* Keep the focus ring above the lanes. */
  [data-type="item"]:before { z-index: 2; }
  [data-item-section="content"] { flex: none; max-width: none; overflow: visible; }
  [data-item-section="decoration"], [data-item-section="git"] {
    position: sticky; z-index: 1; align-self: stretch; display: flex; align-items: center;
    background-color: inherit;
  }
  [data-item-section="git"] { right: var(--lane-pin); }
  /* Covers the names passing the pane's edge, over the scrollbar gutter too; the row clips the overhang while it is no wider than the pane. */
  [data-item-section="git"]::after { content: ""; position: absolute; top: 0; bottom: 0; left: 100%; width: var(--lane-pin); background-color: inherit; }
  /* The library fades the whole lane; a translucent lane would show the names beneath it. */
  [data-item-contains-git-change="true"] > [data-item-section="git"] { opacity: 1; }
  [data-item-contains-git-change="true"] > [data-item-section="git"] > span { opacity: 0.5; }
  [data-item-section="decoration"] {
    flex: none; margin-left: auto;
    right: calc(var(--lane-pin) + var(--trees-git-lane-width));
    /* The gap to the git lane belongs to this lane, so no name shows between them. */
    margin-right: calc(-1 * var(--trees-item-row-gap)); padding-right: var(--trees-item-row-gap);
  }
  /* Names stop a row gap short of the counts while they slide under, as they do at rest. */
  [data-item-section="decoration"]::before { content: ""; position: absolute; top: 0; bottom: 0; right: 100%; width: var(--trees-item-row-gap); background-color: inherit; }
}
`;
