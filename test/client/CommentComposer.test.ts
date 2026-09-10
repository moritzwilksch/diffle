// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CommentComposer } from '../../src/client/review/CommentComposer.js';
import { useStore } from '../../src/client/store.js';

let root: Root;
let host: HTMLDivElement;
const originalDraftQuote = useStore.getState().draftQuote;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this instanceof HTMLTextAreaElement ? this.value.split('\n').length * 18 : 0;
  });
  useStore.setState({ draftQuote: vi.fn(async () => 'one\ntwo\nthree\nfour\nfive\nsix') });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(() => root.render(createElement(CommentComposer, { lines: 'L1–L6' })));
});

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  useStore.setState({ draftQuote: originalDraftQuote });
  vi.restoreAllMocks();
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
