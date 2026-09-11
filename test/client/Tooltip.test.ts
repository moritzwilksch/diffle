// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { TooltipHost } = await import('../../src/client/ui/Tooltip.js');

let root: Root;
let host: HTMLDivElement;
let button: HTMLButtonElement;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(() => root.render(createElement(TooltipHost)));
  button = document.createElement('button');
  button.setAttribute('title', 'Change what is compared (m)');
  button.textContent = 'HEAD';
  document.body.appendChild(button);
});
afterEach(async () => {
  await act(() => root.unmount());
  button.remove();
  host.remove();
  vi.useRealTimers();
});

const tip = () => document.querySelector('[role="tooltip"]');

it('replaces the native title with a tooltip after a short rest', async () => {
  await act(() => button.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })));
  expect(tip()).toBeNull();
  await act(() => vi.advanceTimersByTime(249));
  expect(tip()).toBeNull();
  await act(() => vi.advanceTimersByTime(1));
  expect(tip()?.textContent).toBe('Change what is compared (m)');
  // The attribute is gone while the tip is up, so the browser cannot race its own slow tooltip in.
  expect(button.hasAttribute('title')).toBe(false);
});

it('restores the title when the pointer leaves', async () => {
  await act(() => button.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })));
  await act(() => vi.advanceTimersByTime(250));
  await act(() => button.dispatchEvent(new PointerEvent('pointerout', { bubbles: true })));
  expect(tip()).toBeNull();
  expect(button.getAttribute('title')).toBe('Change what is compared (m)');
});

it('drops a pending tip when the pointer leaves before the rest', async () => {
  await act(() => button.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })));
  await act(() => vi.advanceTimersByTime(100));
  await act(() => button.dispatchEvent(new PointerEvent('pointerout', { bubbles: true })));
  await act(() => vi.advanceTimersByTime(250));
  expect(tip()).toBeNull();
});

it('shows on keyboard focus and closes on Escape', async () => {
  await act(() => button.focus());
  expect(tip()?.textContent).toBe('Change what is compared (m)');
  await act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(tip()).toBeNull();
  expect(button.getAttribute('title')).toBe('Change what is compared (m)');
});

it('does not open when a click focuses the control', async () => {
  const original = Element.prototype.matches;
  const matches = vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
    return selector === ':focus-visible' ? false : original.call(this, selector);
  });
  try {
    await act(() => {
      button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      button.focus();
    });
    expect(tip()).toBeNull();
  } finally {
    matches.mockRestore();
  }
});

it('closes when the page scrolls', async () => {
  await act(() => button.focus());
  await act(() => document.dispatchEvent(new Event('scroll')));
  expect(tip()).toBeNull();
});

it('picks up a title a re-render puts back while the tip is up', async () => {
  await act(() => button.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })));
  await act(() => vi.advanceTimersByTime(250));
  button.title = 'Swap refs (x)';
  await act(() => button.dispatchEvent(new PointerEvent('pointermove', { bubbles: true })));
  expect(tip()?.textContent).toBe('Swap refs (x)');
  expect(button.hasAttribute('title')).toBe(false);
});
