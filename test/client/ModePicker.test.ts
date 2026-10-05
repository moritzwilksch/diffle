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
const { useKeymap } = await import('../../src/client/keyboard/useKeymap.js');
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
  const button = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  expect(button.getAttribute('aria-busy')).toBe('false');
  expect(button.disabled).toBe(false);
  await submit();
  await submit();
  expect(switchMode).toHaveBeenCalledExactlyOnceWith({ kind: 'pr' });
  expect(button.getAttribute('aria-busy')).toBe('true');
  expect(button.disabled).toBe(true);
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

it('defaults to HEAD~1..HEAD~0, steps both offsets by arrows and buttons, and applies them', async () => {
  await act(() => useStore.getState().pickModeEntry(3));
  const base = host.querySelector<HTMLInputElement>('[aria-label="Base offset"]')!;
  const target = host.querySelector<HTMLInputElement>('[aria-label="Target offset"]')!;
  expect(base.value).toBe('1');
  expect(target.value).toBe('0');
  expect(document.activeElement).toBe(base);
  await type('9');
  const up = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
  await act(() => base.dispatchEvent(up));
  expect(up.defaultPrevented).toBe(true);
  expect(base.value).toBe('10');
  expect([base.selectionStart, base.selectionEnd]).toEqual([0, 2]);
  await act(() => host.querySelector<HTMLButtonElement>('[aria-label="Decrease base offset"]')!.click());
  expect(base.value).toBe('9');
  expect(document.activeElement).toBe(base);
  expect([base.selectionStart, base.selectionEnd]).toEqual([0, 1]);
  await act(() => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
  expect(target.value).toBe('0');
  expect(document.activeElement).toBe(target);
  expect([target.selectionStart, target.selectionEnd]).toEqual([0, 1]);
  await act(() => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })));
  await act(() => host.querySelector<HTMLButtonElement>('[aria-label="Increase target offset"]')!.click());
  expect(target.value).toBe('2');
  expect(switchMode).not.toHaveBeenCalled();
  await submit();
  expect(switchMode).toHaveBeenCalledWith({ kind: 'revspec', args: ['HEAD~9..HEAD~2'] });
});

it('keeps ref suggestions closed on pointer and keyboard picks until input interaction', async () => {
  const twoRefs = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Two refs'))!;
  await act(() => twoRefs.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
  const base = host.querySelector<HTMLInputElement>('[aria-label="Base ref"]')!;
  expect(document.activeElement).not.toBe(base);
  expect(host.querySelector('[role="listbox"]')).toBeNull();
  await act(() => base.focus());
  expect(host.querySelector('[role="listbox"]')).toBeNull();
  await act(() => base.click());
  expect(host.querySelector('[role="listbox"]')).not.toBeNull();

  await act(() => useStore.getState().pickModeEntry(3));
  await act(() => useStore.getState().pickModeEntry(2));
  const focused = host.querySelector<HTMLInputElement>('[aria-label="Base ref"]')!;
  expect(document.activeElement).toBe(focused);
  expect(focused.selectionStart).toBe(0);
  expect(focused.selectionEnd).toBe(focused.value.length);
  expect(host.querySelector('[role="listbox"]')).toBeNull();
  await act(() => focused.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
  expect(host.querySelector('[role="listbox"]')).not.toBeNull();
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

it('shows one highlight shared by the pointer and the keyboard', async () => {
  const entries = () => [...host.querySelectorAll<HTMLButtonElement>('#mode-picker > div > button')];
  const highlighted = () => entries().findIndex((b) => b.hasAttribute('data-highlighted')) + 1;
  await act(() => useStore.getState().setModeMenuOpen(true));
  expect(highlighted()).toBe(1);
  await act(() => entries()[2]!.dispatchEvent(new MouseEvent('pointermove', { bubbles: true })));
  expect(highlighted()).toBe(3);
  await act(() => useStore.getState().pickModeEntry(5));
  expect(highlighted()).toBe(5);
  expect(entries().filter((b) => b.hasAttribute('data-highlighted'))).toHaveLength(1);
});

it('leaves Enter to a focused button and keeps a focused entry highlighted', async () => {
  function WithKeys() {
    useKeymap();
    return createElement(ModePicker);
  }
  await act(() => root.render(createElement(WithKeys)));
  const entries = () => [...host.querySelectorAll<HTMLButtonElement>('#mode-picker > div > button')];
  const enter = (el: Element) => {
    const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    act(() => el.dispatchEvent(e));
    return e;
  };
  await act(() => useStore.getState().setModeMenuOpen(true));
  await act(() => entries()[1]!.focus());
  expect(entries()[1]!.hasAttribute('data-highlighted')).toBe(true);
  // j on a focused entry moves focus with the highlight, so native Enter activates the entry shown.
  act(() => entries()[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(entries()[2]);
  expect(useStore.getState().modeEntry).toBe(3);
  await act(() => entries()[1]!.focus());
  expect(enter(entries()[1]!).defaultPrevented).toBe(false);
  expect(useStore.getState().modePane).toBeNull();
  await act(() => entries()[1]!.click()); // the native activation Enter triggers in a browser
  expect(useStore.getState().modePane).toBe('refs');
  const trigger = host.querySelector<HTMLButtonElement>('button[aria-controls="mode-picker"]')!;
  await act(() => trigger.focus());
  expect(enter(trigger).defaultPrevented).toBe(false);
  expect(useStore.getState().modeMenuOpen).toBe(true);
  expect(switchMode).not.toHaveBeenCalled();
});

it('moves focus from another header button onto the entry j highlights', async () => {
  function WithKeys() {
    useKeymap();
    return createElement(ModePicker);
  }
  await act(() => root.render(createElement(WithKeys)));
  const entries = () => [...host.querySelectorAll<HTMLButtonElement>('#mode-picker > div > button')];
  const trigger = host.querySelector<HTMLButtonElement>('button[aria-controls="mode-picker"]')!;
  await act(() => useStore.getState().setModeMenuOpen(true));
  await act(() => trigger.focus());
  act(() => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true })));
  // Native Enter on the trigger would close the menu instead of picking the entry shown.
  expect(document.activeElement).toBe(entries()[1]);
  expect(useStore.getState().modeEntry).toBe(2);
});

it('enters the highlighted pane with l and leaves it with h', async () => {
  function WithKeys() {
    useKeymap();
    return createElement(ModePicker);
  }
  await act(() => root.render(createElement(WithKeys)));
  const entries = () => [...host.querySelectorAll<HTMLButtonElement>('#mode-picker > div > button')];
  const press = (key: string, el: Element = document.activeElement ?? document.body) => {
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    act(() => el.dispatchEvent(e));
    return e;
  };
  await act(() => useStore.getState().setModeMenuOpen(true));
  expect(press('l', document.body).defaultPrevented).toBe(true);
  expect(useStore.getState().modePane).toBeNull(); // Working has no pane
  press('j', document.body);
  press('j', document.body);
  press('l', document.body);
  expect(useStore.getState().modePane).toBe('commits');
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Base offset');
  expect(press('h').defaultPrevented).toBe(false); // an input keeps its letters
  await act(() => entries()[2]!.focus());
  press('h');
  expect(useStore.getState().modePane).toBeNull();
  expect(document.activeElement).toBe(entries()[2]);
  press('ArrowRight');
  expect(useStore.getState().modePane).toBe('commits');
  // With the pane already open, l moves focus into it.
  await act(() => entries()[2]!.focus());
  press('l');
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Base offset');
  await act(() => entries()[2]!.focus());
  press('ArrowLeft');
  expect(useStore.getState().modePane).toBeNull();
  expect(useStore.getState().modeMenuOpen).toBe(true);
  expect(switchMode).not.toHaveBeenCalled();
});

it('closes an open pane on Escape before the menu, keeping the list navigable', async () => {
  function WithKeys() {
    useKeymap();
    return createElement(ModePicker);
  }
  await act(() => root.render(createElement(WithKeys)));
  const entries = () => [...host.querySelectorAll<HTMLButtonElement>('#mode-picker > div > button')];
  const press = (key: string, type = 'keydown') => {
    const el = document.activeElement ?? document.body;
    act(() => el.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true })));
  };
  await act(() => useStore.getState().setModeMenuOpen(true));
  await act(() => useStore.getState().pickModeEntry(3));
  host.querySelector<HTMLInputElement>('input[aria-label="Base offset"]')!.focus();
  press('Escape');
  press('Escape', 'keyup');
  await new Promise((r) => setTimeout(r, 0));
  expect(useStore.getState().modePane).toBeNull();
  expect(useStore.getState().modeMenuOpen).toBe(true);
  expect(document.activeElement).toBe(entries()[2]);
  press('k');
  expect(useStore.getState().modeEntry).toBe(2);
  press('Escape');
  expect(useStore.getState().modeMenuOpen).toBe(false);
});
