// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RefInput } from '../../src/client/header/RefInput.js';

let root: Root;
let host: HTMLDivElement;
const changed = vi.fn();
const accepted = vi.fn();
const refs = {
  defaultBranch: 'main',
  current: 'feature',
  branches: ['main', 'feature'],
  remoteBranches: ['origin/main'],
  tags: ['v1'],
  recent: [{ sha: 'abcdef123', short: 'abcdef1', subject: 'Fix scrolling' }],
};
function Field() {
  const [value, setValue] = useState('main');
  return createElement(RefInput, {
    label: 'Base ref',
    value,
    refs,
    autoFocus: true,
    onAccept: accepted,
    onChange: (next) => {
      setValue(next);
      changed(next);
    },
  });
}
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  changed.mockClear();
  accepted.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(() => root.render(createElement(Field)));
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});
function input() {
  return host.querySelector('input')!;
}
async function type(value: string) {
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function key(key: string) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  await act(() => input().dispatchEvent(event));
  return event;
}

it('focuses the base, filters suggestions, and selects one without submitting', async () => {
  expect(document.activeElement).toBe(input());
  expect(input().selectionStart).toBe(0);
  expect(input().selectionEnd).toBe(4);
  expect(input().getAttribute('aria-expanded')).toBe('false');
  expect(host.querySelector('[role="listbox"]')).toBeNull();
  await type('scroll');
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(1);
  expect(host.querySelector('[role="option"]')?.textContent).toContain('Fix scrolling');
  expect(host.querySelector('[aria-selected="true"]')?.textContent).toContain('Fix scrolling');
  expect((await key('Enter')).defaultPrevented).toBe(true);
  expect(input().value).toBe('abcdef1');
  expect(host.querySelector('[role="listbox"]')).toBeNull();
  expect(accepted).toHaveBeenCalledOnce();
  expect((await key('Enter')).defaultPrevented).toBe(true);
});

it('accepts custom revisions and dismisses suggestions without changing the value', async () => {
  await type('HEAD~3');
  expect(changed).toHaveBeenLastCalledWith('HEAD~3');
  expect(host.querySelector('[role="listbox"]')?.textContent).toContain('Use this revision as typed.');
  expect((await key('Escape')).defaultPrevented).toBe(true);
  expect(input().value).toBe('HEAD~3');
  expect(document.activeElement).toBe(input());
  expect(host.querySelector('[role="listbox"]')).toBeNull();
});

it('advances with a custom revision without submitting', async () => {
  await type('HEAD~3');
  expect((await key('Enter')).defaultPrevented).toBe(true);
  expect(input().value).toBe('HEAD~3');
  expect(accepted).toHaveBeenCalledOnce();
});
