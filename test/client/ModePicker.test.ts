// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../src/client/api.js', () => ({
  api: {
    lastCommitsPreview: vi.fn(async () => ({ old: null, new: null })),
    refs: vi.fn(async () => ({
      defaultBranch: 'main',
      branches: ['main'],
      remoteBranches: [],
      tags: [],
      recent: [],
      current: 'main',
    })),
  },
}));
const { useStore } = await import('../../src/client/store.js');
const { ModePicker } = await import('../../src/client/header/ModePicker.js');
type Result = Awaited<ReturnType<typeof originalSwitchMode>>;
let root: Root;
let host: HTMLDivElement;
let finish: (result: Result) => void;
const switchMode = vi.fn();
const originalSwitchMode = useStore.getState().switchMode;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  switchMode.mockReset();
  switchMode.mockImplementation(
    () =>
      new Promise<Result>((resolve) => {
        finish = resolve;
      }),
  );
  useStore.setState({ modeMenuOpen: true, modePane: 'pr', switchMode });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(() => root.render(createElement(ModePicker)));
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  useStore.setState({ modeMenuOpen: false, modePane: null, switchMode: originalSwitchMode });
});
async function submit() {
  await act(() => {
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}
async function type(value: string) {
  await act(() => {
    const input = host.querySelector('input')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('focuses the PR field and prevents duplicate submissions while opening the current branch PR', async () => {
  expect(document.activeElement).toBe(host.querySelector('input'));
  expect(host.querySelector('button[type="submit"]')?.textContent).toBe('Show PR');
  await submit();
  await submit();
  expect(switchMode).toHaveBeenCalledExactlyOnceWith({ kind: 'pr' });
  expect(host.querySelector('button[type="submit"]')?.textContent).toBe('Loading PR…');
  expect(host.querySelector('button[type="submit"]')).toHaveProperty('disabled', true);
  expect(useStore.getState().modeMenuOpen).toBe(true);
  await act(() => finish('applied'));
  expect(useStore.getState().modeMenuOpen).toBe(false);
});

it('returns focus to the review pane after a successful switch instead of the menu trigger', async () => {
  const review = document.createElement('main');
  review.className = 'review';
  review.tabIndex = -1;
  document.body.appendChild(review);
  try {
    await submit();
    await act(() => finish('applied'));
    expect(document.activeElement).toBe(review);
  } finally {
    review.remove();
  }
});

it('keeps failed input for correction and clears the inline error on editing', async () => {
  await type('123');
  await submit();
  expect(switchMode).toHaveBeenCalledWith({ kind: 'pr', pr: '123' });
  await act(() => finish({ error: 'Pull request not found' }));
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Pull request not found');
  expect(host.querySelector('input')?.value).toBe('123');
  expect(document.activeElement).toBe(host.querySelector('input'));
  expect(useStore.getState().modeMenuOpen).toBe(true);
  await type('https://github.com/org/repo/pull/124');
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await submit();
  expect(switchMode).toHaveBeenLastCalledWith({ kind: 'pr', pr: 'https://github.com/org/repo/pull/124' });
  await act(() => finish('applied'));
});

it('does not close another pane when an older PR request completes', async () => {
  await submit();
  await act(() => useStore.getState().pickModeEntry(3));
  await act(() => finish('applied'));
  expect(useStore.getState().modeMenuOpen).toBe(true);
  expect(useStore.getState().modePane).toBe('commits');
});

it('steps the commit count with arrows and buttons and selects the entire updated value', async () => {
  await act(() => useStore.getState().pickModeEntry(3));
  await type('9');
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Base offset"]')!;
  const up = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
  await act(() => input.dispatchEvent(up));
  expect(up.defaultPrevented).toBe(true);
  expect(input.value).toBe('10');
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(2);
  await act(() => host.querySelector<HTMLButtonElement>('[aria-label="Decrease base offset"]')!.click());
  expect(input.value).toBe('9');
  expect(document.activeElement).toBe(input);
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(1);
  await act(() => host.querySelector<HTMLButtonElement>('[aria-label="Increase base offset"]')!.click());
  expect(input.value).toBe('10');
  expect(input.selectionEnd).toBe(2);
  await type('0');
  await act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
  expect(input.value).toBe('0');
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(1);
  expect(switchMode).not.toHaveBeenCalled();
});

it('defaults to HEAD~1..HEAD~0 and applies both editable offsets', async () => {
  await act(() => useStore.getState().pickModeEntry(3));
  const base = host.querySelector<HTMLInputElement>('[aria-label="Base offset"]')!;
  const target = host.querySelector<HTMLInputElement>('[aria-label="Target offset"]')!;
  expect(base.value).toBe('1');
  expect(target.value).toBe('0');
  expect(document.activeElement).toBe(base);
  await type('5');
  await act(() => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })));
  expect(target.value).toBe('1');
  expect(document.activeElement).toBe(target);
  expect(target.selectionStart).toBe(0);
  expect(target.selectionEnd).toBe(1);
  await act(() => host.querySelector<HTMLButtonElement>('[aria-label="Increase target offset"]')!.click());
  expect(target.value).toBe('2');
  await submit();
  expect(switchMode).toHaveBeenCalledWith({ kind: 'revspec', args: ['HEAD~5..HEAD~2'] });
});

it('swaps refs by button and x without submitting or consuming typed x', async () => {
  await act(() => useStore.getState().pickModeEntry(2));
  const base = host.querySelector<HTMLInputElement>('[aria-label="Base ref"]')!;
  const target = host.querySelector<HTMLInputElement>('[aria-label="Target ref"]')!;
  const swap = host.querySelector<HTMLButtonElement>('[aria-label="Swap refs"]')!;
  await act(() => swap.click());
  expect(base.value).toBe('HEAD');
  expect(target.value).toBe('main');
  const toggle = host.querySelector<HTMLElement>('[role="group"][aria-label^="Comparison:"]')!;
  const key = new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true });
  await act(() => {
    toggle.focus();
    toggle.dispatchEvent(key);
  });
  expect(key.defaultPrevented).toBe(true);
  expect(base.value).toBe('main');
  expect(target.value).toBe('HEAD');
  const typed = new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true });
  await act(() => {
    base.focus();
    base.dispatchEvent(typed);
  });
  expect(typed.defaultPrevented).toBe(false);
  expect(base.value).toBe('main');
  expect(switchMode).not.toHaveBeenCalled();
});
