// @vitest-environment jsdom
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../src/client/api.js', () => ({ api: {} }));
vi.mock('@pierre/diffs/react', () => ({ File: () => null, useWorkerPool: () => null }));

const { useStore } = await import('../../src/client/store.js');
const { HoverTooltip, hoverControl, LINGER_MS } = await import('../../src/client/lsp/HoverTooltip.js');

const target = { path: 'a.py', side: 'new' as const, line: 1, col: 0, text: 'foo' };
const hover = { target, contents: 'foo: int', anchor: { left: 10, top: 20, bottom: 36 } };

let root: Root;
let host: HTMLDivElement;
let token: HTMLSpanElement;
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.appendChild(host);
  token = document.createElement('span');
  document.body.appendChild(token);
  root = createRoot(host);
  useStore.setState({ hover });
  await act(() => root.render(createElement(StrictMode, null, createElement(HoverTooltip))));
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  token.remove();
  useStore.setState({ hover: null });
  vi.useRealTimers();
});

const tip = () => host.querySelector('[role="tooltip"]')!;
/** The pointer crosses from `from` to `to`; React synthesizes the tooltip's enter / leave from this pair. */
const cross = (from: Element, to: Element) =>
  act(() => {
    from.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: to }));
    to.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, relatedTarget: from }));
  });
const linger = () => act(() => vi.advanceTimersByTime(LINGER_MS + 1));

it('stays open when the diff reports the token leave after the pointer already entered the tooltip', async () => {
  // The diff derives token leaves from the <pre>'s pointerleave, which the browser fires after the
  // pointerout React turns into the tooltip's enter.
  await cross(token, tip());
  hoverControl.leave();
  await linger();
  expect(useStore.getState().hover).toEqual(hover);
});

it('closes once the pointer has left both the token and the tooltip', async () => {
  hoverControl.leave();
  await cross(token, tip());
  await linger();
  expect(useStore.getState().hover).toEqual(hover);
  await cross(tip(), document.body);
  await linger();
  expect(useStore.getState().hover).toBeNull();
});

it('keeps a keyboard-opened tooltip with no pointer over it', async () => {
  await linger();
  expect(useStore.getState().hover).toEqual(hover);
});

it('closes after a token leave with no tooltip to travel into', async () => {
  hoverControl.leave();
  await linger();
  expect(useStore.getState().hover).toBeNull();
});

it('forgets a hovered tooltip that was dismissed from under the pointer', async () => {
  await cross(token, tip());
  hoverControl.leave();
  // A key dismisses the tooltip while the pointer sits on it; no leave arrives from the unmounted box.
  await act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' })));
  expect(useStore.getState().hover).toBeNull();
  // The next tooltip must not inherit a stale "pointer over the tooltip".
  await act(() => useStore.setState({ hover }));
  hoverControl.leave();
  await linger();
  expect(useStore.getState().hover).toBeNull();
});
