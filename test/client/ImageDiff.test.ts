// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../../src/shared/protocol.js';

vi.mock('../../src/client/api.js', () => ({
  api: {
    imageUrl: (path: string, rev: string, key: string) => `http://x/api/image?path=${path}&rev=${rev}&key=${key}`,
  },
}));

const { useStore } = await import('../../src/client/store.js');
const { ImageDiff } = await import('../../src/client/review/ImageDiff.js');
const { useKeymap } = await import('../../src/client/keyboard/useKeymap.js');

function Keys() {
  useKeymap();
  return null;
}

/** Natural sizes the stub decoder reports, by URL; a URL missing here fails to decode. */
let decoded: Record<string, [number, number]> = {};
const requested: string[] = [];

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  decoded = {};
  requested.length = 0;
  // jsdom loads no images: this decoder answers from `decoded` on the next task.
  vi.stubGlobal(
    'Image',
    class {
      naturalWidth = 0;
      naturalHeight = 0;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(url: string) {
        requested.push(url);
        setTimeout(() => {
          const size = decoded[url];
          if (!size) return this.onerror?.();
          [this.naturalWidth, this.naturalHeight] = size;
          this.onload?.();
        });
      }
    },
  );
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => stored.set(k, v),
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

let version = 0;
/** A fresh snapshot per test: its blobs key the URLs, so the module's size cache never carries over. */
function snapshot(): Snapshot {
  version++;
  return {
    version,
    oldSha: 'c0',
    newSha: 'worktree',
    changed: [{ path: 'a.png', blob: `new${version}`, oldBlob: `old${version}` }],
  } as unknown as Snapshot;
}
const url = (rev: 'old' | 'new') => `http://x/api/image?path=a.png&rev=${rev}&key=${rev}${version}`;
const settle = () => act(() => new Promise((r) => setTimeout(r, 10)));
const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label)!;

describe('ImageDiff', () => {
  it('shows both sides next to each other, sized to their natural dimensions', async () => {
    useStore.setState({ snapshot: snapshot(), imageCompare: 'side-by-side' });
    decoded = { [url('old')]: [40, 20], [url('new')]: [80, 20] };
    await act(() => root.render(createElement(ImageDiff, { path: 'a.png', sides: 'both' })));
    expect(host.textContent).toContain('Loading image…');
    await settle();
    const imgs = [...host.querySelectorAll('img')];
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual([url('old'), url('new')]);
    expect(imgs[0]!.style.aspectRatio).toBe('40 / 20');
    expect(host.textContent).toContain('Old · 40 × 20');
    expect(host.textContent).toContain('New · 80 × 20');
    for (const img of imgs) expect(img.nextElementSibling?.tagName).toBe('FIGCAPTION');
  });

  it('stacks the sides on one canvas for swipe, onion skin and difference, and remembers the choice', async () => {
    useStore.setState({ snapshot: snapshot(), imageCompare: 'side-by-side' });
    decoded = { [url('old')]: [40, 20], [url('new')]: [80, 40] };
    await act(() => root.render(createElement(ImageDiff, { path: 'a.png', sides: 'both' })));
    await settle();

    await act(() => button('Swipe').click());
    expect(useStore.getState().imageCompare).toBe('swipe');
    const stack = host.querySelector<HTMLElement>('[data-stack="swipe"]')!;
    expect(stack.style.aspectRatio).toBe('80 / 40');
    const [oldImg] = [...stack.querySelectorAll('img')];
    // The smaller side keeps its scale: half the canvas each way, anchored top left.
    expect(oldImg!.style.width).toBe('50%');
    expect(oldImg!.style.height).toBe('50%');
    const newLayer = stack.querySelector<HTMLElement>('[data-layer="new"]')!;
    expect(newLayer.style.clipPath).toBe('inset(0 0 0 50%)');
    expect(host.querySelector('input[type="range"]')).toBeNull();
    const divider = stack.querySelector<HTMLElement>('[role="slider"]')!;
    let captured = false;
    stack.setPointerCapture = vi.fn(() => {
      captured = true;
    });
    stack.hasPointerCapture = vi.fn(() => captured);
    vi.spyOn(stack, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 100 } as DOMRect);
    const pointer = (type: string, clientX: number) =>
      Object.assign(new Event(type, { bubbles: true }), { clientX, pointerId: 1, buttons: 1 });
    await act(() => stack.dispatchEvent(pointer('pointerdown', 20)));
    expect(newLayer.style.clipPath).toBe('inset(0 0 0 20%)');
    await act(() => stack.dispatchEvent(pointer('pointermove', 30)));
    expect(newLayer.style.clipPath).toBe('inset(0 0 0 20%)');
    await act(() => stack.dispatchEvent(pointer('pointerdown', 50)));
    expect(newLayer.style.clipPath).toBe('inset(0 0 0 50%)');
    await act(() => divider.dispatchEvent(pointer('pointerdown', 52)));
    expect(newLayer.style.clipPath).toBe('inset(0 0 0 50%)');
    await act(() => stack.dispatchEvent(pointer('pointermove', 20)));
    expect(divider.getAttribute('aria-valuenow')).toBe('20');
    expect(newLayer.style.clipPath).toBe('inset(0 0 0 20%)');

    await act(() => button('Onion skin').click());
    const opacity = host.querySelector<HTMLInputElement>('input[aria-label="New side opacity"]')!;
    expect(opacity.value).toBe('20');
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(opacity, '30');
      opacity.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.querySelector<HTMLElement>('[data-stack="onion"] [data-layer="new"]')!.style.opacity).toBe('0.3');

    await act(() => button('Difference').click());
    expect(host.querySelector<HTMLElement>('[data-stack="difference"] [data-layer="new"]')!.style.mixBlendMode).toBe(
      'difference',
    );
    expect(localStorage.getItem('diffle:imageCompare')).toBe('difference');
  });

  it('clips on the canvas and lets the focused divider own its keys with the review keymap mounted', async () => {
    useStore.setState({ snapshot: snapshot(), imageCompare: 'swipe' });
    decoded = { [url('old')]: [80, 40], [url('new')]: [40, 20] };
    await act(() =>
      root.render(
        createElement('div', null, createElement(Keys), createElement(ImageDiff, { path: 'a.png', sides: 'both' })),
      ),
    );
    await settle();
    const stack = host.querySelector<HTMLElement>('[data-stack="swipe"]')!;
    const layer = stack.querySelector<HTMLElement>('[data-layer="new"]')!;
    // The layer spans the canvas, so its 50% inset lands on the divider at the canvas's 50%.
    expect(layer.classList.contains('inset-0')).toBe(true);
    expect(layer.style.clipPath).toBe('inset(0 0 0 50%)');
    expect(layer.querySelector('img')!.style.width).toBe('50%');
    const divider = stack.querySelector<HTMLElement>('[role="slider"]')!;
    expect(divider.style.left).toBe('50%');
    const moveCursor = vi.spyOn(useStore.getState(), 'moveCursor');
    const moveCursorBy = vi.spyOn(useStore.getState(), 'moveCursorBy');
    const setLayout = vi.spyOn(useStore.getState(), 'setLayout');
    divider.focus();
    for (const [key, shiftKey, expected] of [
      ['ArrowRight', false, 51],
      ['ArrowLeft', false, 50],
      ['ArrowUp', true, 60],
      ['ArrowDown', true, 50],
      ['Home', false, 0],
      ['End', false, 100],
      ['ArrowRight', false, 100],
    ] as const) {
      await act(() =>
        divider.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })),
      );
      expect(divider.getAttribute('aria-valuenow')).toBe(String(expected));
      expect(layer.style.clipPath).toBe(`inset(0 0 0 ${expected}%)`);
      expect(document.activeElement).toBe(divider);
    }
    expect(moveCursor).not.toHaveBeenCalled();
    expect(moveCursorBy).not.toHaveBeenCalled();
    expect(setLayout).not.toHaveBeenCalled();
  });

  it('shows one side of an added image, with nothing to compare and no request for the missing side', async () => {
    useStore.setState({ snapshot: snapshot(), imageCompare: 'swipe' });
    decoded = { [url('new')]: [10, 10] };
    await act(() => root.render(createElement(ImageDiff, { path: 'a.png', sides: 'new' })));
    await settle();
    expect(requested).toEqual([url('new')]);
    expect(host.querySelectorAll('img')).toHaveLength(1);
    expect(host.querySelector('[aria-label="Image comparison"]')).toBeNull();
  });

  it('retries a side that failed to load once it mounts again', async () => {
    useStore.setState({ snapshot: snapshot(), imageCompare: 'side-by-side' });
    await act(() => root.render(createElement(ImageDiff, { path: 'a.png', sides: 'new' })));
    await settle();
    expect(host.textContent).toContain('Binary file: not a displayable image');

    await act(() => root.render(createElement('div')));
    decoded = { [url('new')]: [10, 10] };
    await act(() => root.render(createElement(ImageDiff, { path: 'a.png', sides: 'new' })));
    await settle();
    expect(requested).toEqual([url('new'), url('new')]);
    expect(host.querySelector('img')!.getAttribute('src')).toBe(url('new'));
  });

  it('falls back to side by side with a note when a side does not decode', async () => {
    useStore.setState({ snapshot: snapshot(), imageCompare: 'difference' });
    decoded = { [url('new')]: [10, 10] };
    await act(() => root.render(createElement(ImageDiff, { path: 'a.png', sides: 'both' })));
    await settle();
    expect(host.querySelector('[data-stack]')).toBeNull();
    expect(host.textContent).toContain('Binary file: not a displayable image');
    expect(button('Swipe').disabled).toBe(true);
    expect(host.querySelectorAll('img')).toHaveLength(1);
  });
});
