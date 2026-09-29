// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CommentComposer } from '../../src/client/review/CommentComposer.js';
import { useStore } from '../../src/client/store.js';

let root: Root;
let host: HTMLDivElement;
const originalDraftQuote = useStore.getState().draftQuote;
// JSDOM has no layout: `laidOut` stands in for whether the viewer has rendered the composer's row.
let laidOut = true;
let resized: (() => void) | undefined;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  laidOut = true;
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(
    () => (laidOut ? [new DOMRect(0, 0, 100, 20)] : []) as unknown as DOMRectList,
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resized = callback;
      }
      observe() {}
      disconnect() {
        resized = undefined;
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this instanceof HTMLTextAreaElement ? this.value.split('\n').length * 18 : 0;
  });
  useStore.setState({ draftQuote: vi.fn(async () => 'one\ntwo\nthree\nfour\nfive\nsix') });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(() => root.render(createElement(CommentComposer, { label: 'L1–6' })));
});

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  useStore.setState({ draftQuote: originalDraftQuote });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('takes focus once the viewer lays it out, not while it mounts off screen', async () => {
  await act(() => root.render(null));
  laidOut = false;
  await act(() => root.render(createElement(CommentComposer, { label: 'whole file' })));
  const textarea = host.querySelector('textarea')!;
  expect(document.activeElement).not.toBe(textarea);
  resized!();
  expect(document.activeElement).not.toBe(textarea);
  laidOut = true;
  resized!();
  expect(document.activeElement).toBe(textarea);
  expect(resized).toBeUndefined();
});

it('names the lines the comment attaches to in its header', () => {
  expect(host.querySelector('span.font-mono')!.textContent).toBe('L1–6');
});

it('grows for an inserted multiline suggestion and shrinks when text is removed', async () => {
  const textarea = host.querySelector('textarea')!;
  // JSDOM has no layout; supply the border widths used by the rendered textarea.
  textarea.style.border = '1px solid';
  const suggest = [...host.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Suggest change'),
  )!;
  await act(() => suggest.click());
  expect(textarea.value).toBe('```suggestion\none\ntwo\nthree\nfour\nfive\nsix\n```\n');
  expect(textarea.style.height).toBe('164px');
  expect(document.activeElement).toBe(textarea);
  expect(textarea.classList.contains('max-h-[60vh]')).toBe(true);
  expect(textarea.classList.contains('resize-y')).toBe(true);

  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'short');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(textarea.style.height).toBe('20px');
});
