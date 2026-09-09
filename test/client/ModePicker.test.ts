// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../src/client/api.js', () => ({
  api: {
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
  await submit();
  await submit();
  expect(switchMode).toHaveBeenCalledExactlyOnceWith({ kind: 'pr' });
  expect(host.querySelector('button[type="submit"]')?.textContent).toBe('Opening PR…');
  expect(host.querySelector('button[type="submit"]')).toHaveProperty('disabled', true);
  expect(useStore.getState().modeMenuOpen).toBe(true);
  await act(() => finish('applied'));
  expect(useStore.getState().modeMenuOpen).toBe(false);
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
