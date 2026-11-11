import { useEffect, useRef, useState } from 'react';
import { elementAt, NODE_ATTR, type Spot } from './anchor.js';

/**
 * The blocks a thread may sit on as a whole, as `crates/diffle/src/tour/anchor.rs` allows; a
 * diagram's boxes and labels take one too (`shapeAt`).
 */
const BLOCKS = new Set([
  'diffle-card',
  'diffle-diff',
  'diffle-walk',
  'diffle-code',
  'diffle-tree',
  'diffle-callout',
  'diffle-diagram',
  'table',
]);

/** The source element at `node` in the tour's document `body`. */
export function sourceAt(body: Element, node: readonly number[]): Element | null {
  let at: Element | undefined = body;
  for (const i of node) at = at?.children[i];
  return at ?? null;
}

/** What a draft on a whole element shows as its label before the server names it: a card's title. */
export function sourceLabel(source: Element): string {
  return source.localName === 'diffle-card' ? (source.getAttribute('title') ?? '') : '';
}

function nodeOf(el: Element): number[] {
  return el.getAttribute(NODE_ATTR)!.split('.').map(Number);
}

/** The innermost block around `target` that takes a thread as a whole; diagram shapes aside. */
export function blockAround(target: Element, body: Element): { el: Element; node: number[]; tag: string } | null {
  for (let el = target.closest(`[${NODE_ATTR}]`); el; el = el.parentElement?.closest(`[${NODE_ATTR}]`) ?? null) {
    const node = nodeOf(el);
    const source = sourceAt(body, node);
    if (source && BLOCKS.has(source.localName)) return { el, node, tag: source.localName };
  }
  return null;
}

/**
 * The diagram shape a click at (x, y) in `svg` is about: the smallest box holding the point, as a
 * label inside a box belongs to it, or else the label under it.
 */
export function shapeAt(svg: Element, target: Element, x: number, y: number): number[] | null {
  const boxes = [...svg.querySelectorAll(`rect[${NODE_ATTR}]`)].filter((r) => {
    const b = r.getBoundingClientRect();
    return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
  });
  const area = (r: Element) => r.getBoundingClientRect().width * r.getBoundingClientRect().height;
  const box = boxes.sort((a, b) => area(a) - area(b))[0];
  if (box) return nodeOf(box);
  const label = target.closest(`text[${NODE_ATTR}]`);
  return label ? nodeOf(label) : null;
}

/** How long a block's Comment button outlasts the pointer leaving it: time to reach the button. */
const GRACE_MS = 300;

/**
 * The block under the pointer, kept a moment after the pointer leaves it so it can reach the
 * block's button, and for as long as it rests there. `enter` takes the block now under the pointer
 * (null for none); `hold` and `release` are the button's.
 */
export function useHoveredBlock<B extends { el: Element }>(): {
  block: B | null;
  enter: (found: B | null) => void;
  hold: () => void;
  release: () => void;
} {
  const [block, setBlock] = useState<B | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hold = () => {
    if (timer.current != null) clearTimeout(timer.current);
    timer.current = null;
  };
  // Pending already: the pointer moving on through prose must not put the end off.
  const release = () => {
    timer.current ??= setTimeout(() => {
      timer.current = null;
      setBlock(null);
    }, GRACE_MS);
  };
  const enter = (found: B | null) => {
    if (!found) return release();
    hold();
    setBlock((prev) => (prev?.el === found.el ? prev : found));
  };
  useEffect(() => hold, []);
  return { block, enter, hold, release };
}

const MARK = 'data-comment';
const MARK_ACTIVE = 'data-comment-active';

/** Marks each element a thread or the draft is on as a whole, for the stylesheet; the active one apart. */
export function useElementMarks(
  article: HTMLElement | null,
  anchors: readonly { id: string; anchor: Spot }[],
  active: string | null,
  layout: unknown,
): void {
  useEffect(() => {
    if (!article) return;
    const marked: Element[] = [];
    for (const { id, anchor } of anchors) {
      if (anchor.target.on !== 'element') continue;
      const el = elementAt(article, anchor.node);
      if (!el) continue;
      el.setAttribute(MARK, '');
      if (id === active) el.setAttribute(MARK_ACTIVE, '');
      marked.push(el);
    }
    return () => {
      for (const el of marked) {
        el.removeAttribute(MARK);
        el.removeAttribute(MARK_ACTIVE);
      }
    };
  }, [article, anchors, active, layout]);
}
