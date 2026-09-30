// @vitest-environment jsdom
import type { FileDiffMetadata } from '@pierre/diffs';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/client/api.js', () => ({ api: {} }));
const diffs = vi.hoisted(() => ({ rendered: [] as FileDiffMetadata[] }));
vi.mock('@pierre/diffs/react', () => ({
  File: () => null,
  FileDiff: ({ fileDiff }: { fileDiff: FileDiffMetadata }) => {
    diffs.rendered.push(fileDiff);
    return null;
  },
  useWorkerPool: () => null,
}));

const { useStore } = await import('../../src/client/store.js');
const { Markdown } = await import('../../src/client/Markdown.js');

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  diffs.rendered = [];
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

describe('Markdown suggestion fences', () => {
  it('labels a ```suggestion fence and keeps its code verbatim', async () => {
    await act(() => root.render(createElement(Markdown, { text: 'Try:\n\n```suggestion\nx = 1\n```' })));
    const block = host.querySelector('pre.suggestion');
    expect(block?.querySelector('.tag')?.textContent).toBe('Suggested change');
    expect(block?.querySelector('code')?.textContent).toBe('x = 1\n');
  });

  it('renders a suggestion for a known file as a highlighted block', async () => {
    await act(() => root.render(createElement(Markdown, { text: '```suggestion\nx = 1\n```', path: 'a.py' })));
    expect(host.querySelector('.suggestion.highlighted')?.querySelector('.tag')?.textContent).toBe('Suggested change');
  });

  it('renders a suggestion on quoted lines as a diff from them', async () => {
    const text = '```suggestion\nx = 2\n```';
    await act(() => root.render(createElement(Markdown, { text, path: 'a.py', quoted: 'x = 1\ny = 1' })));
    const [diff] = diffs.rendered;
    expect(diff?.hunks.map((h) => [h.deletionLines, h.additionLines])).toEqual([[2, 1]]);
  });

  it('renders an empty suggestion as deleting the quoted lines', async () => {
    await act(() =>
      root.render(createElement(Markdown, { text: '```suggestion\n```', path: 'a.py', quoted: 'x = 1' })),
    );
    const [diff] = diffs.rendered;
    expect(diff?.hunks.map((h) => [h.deletionLines, h.additionLines])).toEqual([[1, 0]]);
  });

  it('renders an unchanged suggestion as the lines it keeps', async () => {
    const text = '```suggestion\nx = 1\n```';
    await act(() => root.render(createElement(Markdown, { text, path: 'a.py', quoted: 'x = 1' })));
    expect(diffs.rendered).toEqual([]);
    expect(host.querySelector('.suggestion.highlighted')).not.toBeNull();
  });

  it('reads an empty quote as the blank line it was', async () => {
    const text = '```suggestion\nx = 1\n```';
    await act(() => root.render(createElement(Markdown, { text, path: 'a.py', quoted: '' })));
    const [diff] = diffs.rendered;
    expect(diff?.hunks.map((h) => [h.deletionLines, h.additionLines])).toEqual([[1, 1]]);
  });

  it('ignores the CRs a quote from a CRLF file keeps', async () => {
    const quoted = 'x = 1\r\ny = 1\r';
    const text = '```suggestion\nx = 1\ny = 2\n```';
    await act(() => root.render(createElement(Markdown, { text, path: 'a.py', quoted })));
    const [diff] = diffs.rendered;
    expect(diff?.hunks.map((h) => [h.deletionLines, h.additionLines])).toEqual([[1, 1]]);
    diffs.rendered = [];
    const kept = '```suggestion\nx = 1\ny = 1\n```';
    await act(() => root.render(createElement(Markdown, { text: kept, path: 'a.py', quoted })));
    expect(diffs.rendered).toEqual([]);
    expect(host.querySelector('.suggestion.highlighted')).not.toBeNull();
  });
});
