// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/client/api.js', () => ({ api: {} }));
vi.mock('@pierre/diffs/react', () => ({ File: () => null, useWorkerPool: () => null }));

const { useStore } = await import('../../src/client/store.js');
const { Markdown } = await import('../../src/client/Markdown.js');

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});

const render = async (text: string) => {
  await act(() => root.render(createElement(Markdown, { text })));
  return host.querySelector('a')!;
};

describe('Markdown links', () => {
  it('follows a diffle: link in the app instead of opening a tab', async () => {
    const goToLink = vi.fn(async () => {});
    useStore.setState({ goToLink });
    const a = await render('Go to [f](diffle:src/a%20b.py#L12)');
    expect(a.target).toBe('');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => {
      a.dispatchEvent(click);
    });
    expect(goToLink).toHaveBeenCalledWith('src/a b.py', 12);
    expect(click.defaultPrevented).toBe(true);
  });

  it('opens every other link in a new tab', async () => {
    const a = await render('See [docs](https://example.com/x)');
    expect(a.href).toBe('https://example.com/x');
    expect(a.target).toBe('_blank');
  });
});
