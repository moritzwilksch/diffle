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
