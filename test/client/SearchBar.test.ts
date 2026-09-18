// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../src/client/api.js', () => ({ api: {} }));
const { useStore } = await import('../../src/client/store.js');
const { SearchBar } = await import('../../src/client/keyboard/SearchBar.js');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useStore.setState((s) => ({
    activePath: 'a.txt',
    search: {
      ...s.search,
      open: false,
      query: '',
      input: '',
      matches: [],
      kind: 'text',
      scope: 'diff',
      content: { file: 'diff', diff: 'diff' },
    },
  }));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root.render(
      createElement(
        'div',
        null,
        createElement('header', null, createElement(SearchBar)),
        createElement('section', null, createElement(SearchBar, { path: 'a.txt' })),
      ),
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it('keeps the local form mounted when toggling and remembers the global mode separately', () => {
  act(() => useStore.getState().openSearch('file'));
  const input = host.querySelector('section input');
  const toggle = () => host.querySelector<HTMLButtonElement>('[aria-label="Search full file"]')!;
  act(() => toggle().click());
  expect(host.querySelector('section input')).toBe(input);
  expect(host.querySelector('header input')).toBeNull();
  expect(toggle().getAttribute('aria-pressed')).toBe('true');
  expect(useStore.getState().search.path).toBe('a.txt');

  act(() => useStore.getState().openSearch('diff'));
  expect(host.querySelector('header input')).not.toBeNull();
  expect(toggle().getAttribute('aria-pressed')).toBe('false');
  act(() => toggle().click());
  expect(host.querySelector('header input')).not.toBeNull();
  act(() => useStore.getState().openSearch('file'));
  expect(toggle().getAttribute('aria-pressed')).toBe('true');
  act(() => toggle().click());
  act(() => useStore.getState().openSearch('diff'));
  expect(toggle().getAttribute('aria-pressed')).toBe('true');
});
