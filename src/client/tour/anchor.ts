import type { TourTargetRequest } from '@/shared/tour.js';

/**
 * Where a thread sits on the rendered tour. Each rendered element the source document holds carries
 * its place in `data-node` (child-element indices from `<body>`, dot-joined); blocks whose content is
 * code or a drawing carry `data-opaque` and add nothing to the reading text. The reading text is the
 * one `crates/diffle/src/tour/reading.rs` defines on the source; both ignore whitespace.
 */
export const NODE_ATTR = 'data-node';
export const OPAQUE_ATTR = 'data-opaque';

/** `el`'s place in its document: child-element indices from `<body>`. */
export function nodePath(el: Element): number[] {
  const path: number[] = [];
  for (let at: Element | null = el; at && at.localName !== 'body'; at = at.parentElement) {
    if (!at.parentElement) break;
    path.unshift([...at.parentElement.children].indexOf(at));
  }
  return path;
}

export function nodeKey(node: readonly number[]): string {
  return node.join('.');
}

/** What a rendered element carries to name its source element's place. */
export interface Place {
  'data-node': string;
}

export function placeOf(source: Element): Place {
  return { 'data-node': nodeKey(nodePath(source)) };
}

/** The rendered element at `node` under `root`. */
export function elementAt(root: ParentNode, node: readonly number[]): Element | null {
  return root.querySelector(`[${NODE_ATTR}="${nodeKey(node)}"]`);
}

/** Each non-whitespace character of `el`'s reading text, with the text node and offset it sits at. */
function readingChars(el: Element): { text: string; at: [Text, number][] } {
  const at: [Text, number][] = [];
  let text = '';
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) =>
      n instanceof Element && n.hasAttribute(OPAQUE_ATTR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!(n instanceof Text)) continue;
    const data = n.data;
    for (let i = 0; i < data.length; i++) {
      if (/\s/.test(data[i]!)) continue;
      text += data[i];
      at.push([n, i]);
    }
  }
  return { text, at };
}

function squash(text: string): string {
  return text.replace(/\s+/g, '');
}

/** Where each match of `quoted` starts in `text`, overlaps included. */
function matchStarts(text: string, quoted: string): number[] {
  const starts: number[] = [];
  if (!quoted) return starts;
  for (let i = text.indexOf(quoted); i >= 0; i = text.indexOf(quoted, i + 1)) starts.push(i);
  return starts;
}

/** What a thread on the selection would be on, or why it can be none; null for no selection in `article`. */
export function selectionTarget(
  selection: Selection | null,
  article: Element,
): { node: number[]; target: TourTargetRequest } | { refused: string } | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!article.contains(range.commonAncestorContainer)) return null;
  const quoted = range.toString().replace(/\s+/g, ' ').trim();
  if (!quoted) return null;
  const common = range.commonAncestorContainer;
  const start = common instanceof Element ? common : common.parentElement;
  if (start?.closest(`[${OPAQUE_ATTR}]`)) return { refused: 'Comment on a diff, code or a diagram as a whole' };
  const holder = start?.closest(`[${NODE_ATTR}]`);
  if (!holder || !article.contains(holder)) return { refused: 'Select text within one block to comment on it' };
  const { text, at } = readingChars(holder);
  // The first character at or after the selection's start: whitespace before it is no part of the quote.
  const first = at.findIndex(([n, i]) => range.comparePoint(n, i) >= 0);
  const occurrence = matchStarts(text, squash(quoted)).filter((s) => s < first).length;
  const node = holder.getAttribute(NODE_ATTR)!.split('.').map(Number);
  return { node, target: { on: 'text', quoted, occurrence } };
}

/** What a thread or a draft is on: an element, or words in it. A saved anchor carries more. */
export interface Spot {
  node: readonly number[];
  target: TourTargetRequest;
}

/** The rendered words a text anchor is on, or null when the page no longer shows them. */
export function textRange(root: ParentNode, anchor: Spot): Range | null {
  if (anchor.target.on !== 'text') return null;
  const el = elementAt(root, anchor.node);
  if (!el) return null;
  const { text, at } = readingChars(el);
  const quoted = squash(anchor.target.quoted);
  const start = matchStarts(text, quoted)[anchor.target.occurrence];
  if (start == null) return null;
  const [from, fromAt] = at[start]!;
  const [to, toAt] = at[start + quoted.length - 1]!;
  const range = document.createRange();
  range.setStart(from, fromAt);
  range.setEnd(to, toAt + 1);
  return range;
}

/**
 * The top of what a thread is on, in client coordinates: its words, or the element, or the nearest
 * shown element around it, as tabs around a pane they do not show; null when the page shows none.
 */
export function anchorTop(root: ParentNode, anchor: Spot): number | null {
  const rect = anchor.target.on === 'text' ? textRange(root, anchor)?.getClientRects()[0] : undefined;
  if (rect) return rect.top;
  for (let n = anchor.node.length; n > 0; n--) {
    const el = elementAt(root, anchor.node.slice(0, n));
    if (el) return el.getBoundingClientRect().top;
  }
  return null;
}
