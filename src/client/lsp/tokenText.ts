/**
 * A highlighter token's text is not always one text node: a word-level diff mark nests spans
 * inside it (`<span data-char><span>pkg.</span><span data-diff-span><span>mod</span></span></span>`).
 * Offsets here are UTF-16 offsets into the token's whole text.
 */

/** The token's text nodes, in document order. */
export function textNodes(el: Element): Text[] {
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  return nodes;
}

/** A DOM range over `[from, to)` of the token's text, or null when the token has no text. */
export function tokenRange(el: Element, from: number, to: number): Range | null {
  const nodes = textNodes(el);
  if (!nodes.length) return null;
  const range = el.ownerDocument.createRange();
  range.setStart(...locate(nodes, from));
  range.setEnd(...locate(nodes, to, true));
  return range;
}

/** Text node and offset for an offset into the token's text; `end` keeps a boundary inside the earlier node. */
function locate(nodes: Text[], offset: number, end = false): [Text, number] {
  let at = 0;
  for (const node of nodes) {
    const next = at + node.data.length;
    if (end ? offset <= next : offset < next) return [node, offset - at];
    at = next;
  }
  const last = nodes[nodes.length - 1]!;
  return [last, last.data.length];
}

/**
 * Offset of the character under a viewport point inside the token, or -1 off its text. Takes y as well as x:
 * a wrapped token's characters share x positions across visual lines.
 */
export function charAtPoint(el: Element, x: number, y: number): number {
  const root = el.getRootNode();
  const caret = el.ownerDocument.caretPositionFromPoint(
    x,
    y,
    root instanceof ShadowRoot ? { shadowRoots: [root] } : undefined,
  );
  const nodes = textNodes(el);
  const node = nodes.indexOf(caret?.offsetNode as Text);
  if (!caret || node < 0) return -1;
  const offset = nodes.slice(0, node).reduce((at, n) => at + n.data.length, caret.offset);
  const length = nodes.reduce((at, n) => at + n.data.length, 0);
  // The caret lands on the boundary nearer the point: the character under it starts there or ends there.
  return (
    [offset - 1, offset].find((i) => {
      if (i < 0 || i >= length) return false;
      const r = tokenRange(el, i, i + 1)!.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }) ?? -1
  );
}
