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
/* A row short of room gives up its counts before its name, and the viewed mark never: the parts lay out
 * from the right, and those that no longer fit wrap onto a hidden second line, leftmost first. */
[data-item-section="decoration"] { flex: 1 1000 auto; min-width: min-content; overflow: visible; }
[data-item-section="decoration"] > span {
  flex-flow: row-reverse wrap; height: 1lh; gap: 0.375rem; overflow: hidden; font-variant-numeric: tabular-nums;
}
[data-item-section="decoration"] > span > span:last-child { order: 1; min-width: 1ch; text-align: center; }
[data-item-section="decoration"] > span > span:nth-last-child(2) { order: 2; }
[data-item-section="decoration"] > span > span:nth-last-child(3) { order: 3; }
/* An unchanged row has nothing to show in its lanes; dropped, they leave the name the whole row, and
 * while scrolling sideways no opaque lane is pinned over its tail. */
[data-type="item"]:has(> [data-item-section="decoration"]:empty) > :is([data-item-section="decoration"], [data-item-section="git"]) { display: none; }
/* The tree shows a name's ellipsis once a hidden wrapping copy makes its cell taller than 1lh. At a
 * fractional browser zoom (110%) fixed-point rounding leaves every cell a hair taller, and the marker
 * then paints over names that fit (pierrecomputer/pierre#816). A wrapped copy is at least 2lh tall. */
@container measure (height < 1.5lh) { [data-truncate-marker] { opacity: 0; } }
/* A row scrolling into view is rendered afresh, and the ellipsis would fade in over a name already cut. */
[data-truncate-container] { --truncate-marker-fade-in-duration: 0s; }
/* The library butts the search box against the toolbar above; give it the toolbar's own vertical rhythm. */
[data-file-tree-search-container] { padding-top: 0.5rem; }
/* An input's intrinsic width (its default 20 characters) would hold it wider than a narrow pane. */
[data-file-tree-search-input] { min-width: 0; }
:host([data-search-empty]) [data-file-tree-virtualized-scroll] { display: none; }

:host([data-hscroll]) {
  /* A swipe past either end must not become the browser's back gesture. */
  [data-file-tree-virtualized-scroll] { overscroll-behavior-x: contain; }
  /* \`pinLanes\` sets \`--scroll-tail\`, how far short of its content's end the browser stops the scroll. */
  [data-file-tree-virtualized-list] {
    width: max-content; min-width: calc(100% - var(--scroll-tail, 0px)); padding-right: var(--scroll-tail, 0px);
  }
  [data-type="item"] {
    /* \`pinLanes\` sets \`--lane-gutter\`: whether a sticky offset counts the scrollbar gutter depends on the browser. */
    --lane-pin: calc(var(--lane-edge) + var(--lane-gutter, 0px));
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

interface Edges {
  /** How far past the inner edge a sticky `right: 0` lands. */
  sticky: number;
  /** How far past the inner edge the content ends once scrolled as far right as it goes. */
  tail: number;
}

/** Where a box styled like the tree's scroller puts its right edges, with or without a vertical scrollbar. */
function measureEdges(shadow: ShadowRoot, scrollsVertically: boolean): Edges {
  const box = document.createElement('div');
  box.setAttribute('data-file-tree-scrollbar-measure', 'true');
  const content = box.appendChild(document.createElement('div'));
  content.style.cssText = `display: flex; width: 200%; height: ${scrollsVertically ? 300 : 50}%`;
  const pin = content.appendChild(document.createElement('span'));
  pin.style.cssText = 'position: sticky; right: 0; margin-left: auto; width: 1px';
  shadow.append(box);
  box.scrollLeft = box.scrollWidth;
  const inner = box.getBoundingClientRect().left + box.clientLeft + box.clientWidth;
  const past = (el: Element) => Math.max(el.getBoundingClientRect().right - inner, 0);
  const edges = { sticky: past(pin), tail: past(content) };
  box.remove();
  return edges;
}

/**
 * Keeps the host's `--lane-gutter` at the offset that pins the lanes where they stand without the
 * scroll, and `--scroll-tail` at the room that lets the rows scroll fully into view. Chromium on
 * Linux counts the scrollbar gutter in a sticky offset; on macOS, while the box has no vertical
 * scrollbar, it does and also stops the scroll a gutter short. Returns the cleanup.
 */
export function pinLanes(host: HTMLElement): () => void {
  const shadow = host.shadowRoot;
  const pane = shadow?.querySelector('[data-file-tree-virtualized-scroll]');
  if (!shadow || !pane) return () => {};
  const edges = { scrolling: measureEdges(shadow, true), still: measureEdges(shadow, false) };
  const update = () => {
    const { sticky, tail } = pane.scrollHeight > pane.clientHeight ? edges.scrolling : edges.still;
    host.style.setProperty('--lane-gutter', `${sticky}px`);
    host.style.setProperty('--scroll-tail', `${tail}px`);
  };
  // The list's height follows its rows, so expanding or filtering re-checks the vertical scrollbar.
  const observer = new ResizeObserver(update);
  observer.observe(pane);
  for (const list of pane.children) observer.observe(list);
  update();
  return () => observer.disconnect();
}
