import { type RefObject, useCallback, useEffect, useState } from 'react';
import { create } from 'zustand';
import { useStore } from '@/client/store.js';
import type { Place } from '@/client/tour/anchor.js';

/**
 * What every stepped block shares (a walk, a trace, a stepped diagram): which step is taken, the
 * keys that step the block the reader is at, and the scroll that keeps a step in view.
 */

/** Where a stepped block starts: at rest, nothing taken, or on its first step, as a trace does. */
export type StepStart = 'rest' | 'first';

/** Each stepped block on the page with what steps it: by one on, or back. */
const steppers = new Map<Element, (by: 1 | -1) => void>();

/** A block's box beside the view's, as `keyTarget` weighs them. */
export interface Placed<T> {
  block: T;
  top: number;
  bottom: number;
}

/**
 * The one block the keys step: the topmost wholly in the view (`top` to `bottom`), else the one
 * covering the most of it, as a block taller than the view does. Null when none shows.
 */
export function keyTarget<T>(blocks: readonly Placed<T>[], top: number, bottom: number): T | null {
  const whole = blocks.filter((b) => b.top >= top && b.bottom <= bottom).sort((a, b) => a.top - b.top)[0];
  if (whole) return whole.block;
  let best: { block: T; shown: number } | null = null;
  for (const b of blocks) {
    const shown = Math.min(b.bottom, bottom) - Math.max(b.top, top);
    if (shown > 0 && (!best || shown > best.shown)) best = { block: b.block, shown };
  }
  return best?.block ?? null;
}

/** The block the keys step now, which its stepper marks so a keypress is predictable. */
const useTarget = create<{ target: Element | null }>(() => ({ target: null }));

/** Finds the block the keys step again: after a scroll, a resize, or a block coming or going. */
export function retarget(): void {
  const page = stepPage.current;
  const view = page?.getBoundingClientRect();
  const placed = [...steppers.keys()].map((block) => {
    const box = block.getBoundingClientRect();
    return { block, top: box.top, bottom: box.bottom };
  });
  const target = view ? keyTarget(placed, view.top, view.bottom) : null;
  if (useTarget.getState().target !== target) useTarget.setState({ target });
}

/** Steps the block the keys step by one; false when no block shows. */
export function stepTarget(by: 1 | -1): boolean {
  retarget();
  const target = useTarget.getState().target;
  const step = target && steppers.get(target);
  step?.(by);
  return step != null;
}

/** The tour's scrolling page, which a stepped block scrolls to keep its step in view. */
export const stepPage: { current: HTMLElement | null } = { current: null };

/** Room kept between a step and the page's edge when stepping scrolls. */
const EDGE = 16;

/** Scrolls the page just enough to show `top` to `bottom` (client y); not at all when they show. */
export function reveal(top: number, bottom: number): void {
  const page = stepPage.current;
  if (!page) return;
  const view = page.getBoundingClientRect();
  const above = top - (view.top + EDGE);
  const below = bottom - (view.bottom - EDGE);
  // Too tall to fit: its top shows first.
  const by = above < 0 ? above : below > 0 ? Math.min(below, above) : 0;
  if (by !== 0) page.scrollBy({ top: by, behavior: 'smooth' });
}

/** A stepped block's taken step and how it moves. */
export interface Steps {
  /** The taken step; null at rest. */
  active: number | null;
  /** Takes a step, or rest with null where the block has one. */
  take: (at: number | null) => void;
  step: (by: 1 | -1) => void;
  /** Whether a step back does nothing: at rest, or on the first step of a block without rest. */
  atStart: boolean;
  /** Whether the keys step this block now. */
  targeted: boolean;
  /** Whether the block has a rest, with no step taken. */
  rests: boolean;
}

/**
 * The step state of a block of `count` steps rendered in `el`, which the keys step while the
 * reader is at it. Stepping back from the first step returns to rest when the block starts there.
 */
export function useSteps(el: RefObject<Element | null>, count: number, start: StepStart): Steps {
  const floor = start === 'rest' ? null : 0;
  const [active, setActive] = useState<number | null>(floor);
  const step = useCallback(
    (by: 1 | -1) =>
      setActive((at) => {
        if (at == null) return by > 0 ? 0 : null;
        const next = at + by;
        return next < 0 ? floor : Math.min(next, count - 1);
      }),
    [count, floor],
  );
  const take = useCallback((at: number | null) => setActive(at ?? floor), [floor]);
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    steppers.set(node, step);
    retarget();
    return () => {
      steppers.delete(node);
      retarget();
    };
  }, [el, step]);
  const targeted = useTarget((s) => s.target != null && s.target === el.current);
  return { active, take, step, atStart: active === floor, targeted, rests: floor == null };
}

/**
 * The child of the block at `place` that the focused thread is on, by its index among the block's
 * child elements: a block takes that step, so the thread's words show beside its card.
 */
export function useFocusedChild(place: Place, onFocus: (child: number) => void): void {
  const block = place['data-node'];
  const child = useStore((s) => {
    const thread = s.focusedThread == null ? undefined : s.threads.find((t) => t.id === s.focusedThread);
    if (thread?.anchor.kind !== 'tour') return null;
    const node = thread.anchor.node.join('.');
    return node.startsWith(`${block}.`) ? Number(node.slice(block.length + 1).split('.')[0]) : null;
  });
  useEffect(() => {
    if (child != null) onFocus(child);
  }, [child, onFocus]);
}
