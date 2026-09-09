// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { CodeViewHandle } from '@pierre/diffs/react';
import { watchRenderedRows } from '../../src/client/review/rows.js';

const frame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));

describe('watchRenderedRows', () => {
  it('runs one pass per frame for mount, scroll, store, and row mutations, and stops on teardown', async () => {
    const scroller = document.createElement('div');
    document.body.append(scroller);
    const item = document.createElement('div');
    scroller.append(item);
    const viewer = () =>
      ({
        getInstance: () => ({ getRenderedItems: () => [{ id: 'diff:a.ts:1', element: item }] }),
      }) as unknown as CodeViewHandle<unknown>;
    let notify = () => {};
    const apply = vi.fn();
    const onMutation = vi.fn();
    const stop = watchRenderedRows(viewer, scroller, (schedule) => ((notify = schedule), () => {}), apply, onMutation);
    await frame();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]![0]).toEqual([{ id: 'diff:a.ts:1', root: item }]);
    scroller.dispatchEvent(new Event('scroll'));
    notify();
    await frame();
    expect(apply).toHaveBeenCalledTimes(2);
    // A row appearing inside the item is reported and reapplied.
    item.append(document.createElement('div'));
    await frame();
    expect(onMutation).toHaveBeenCalled();
    expect(apply).toHaveBeenCalledTimes(3);
    stop();
    scroller.dispatchEvent(new Event('scroll'));
    await frame();
    expect(apply).toHaveBeenCalledTimes(3);
    scroller.remove();
  });
});
