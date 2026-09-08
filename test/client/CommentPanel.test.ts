// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentThread } from '../../src/shared/protocol.js';

vi.mock('../../src/client/api.js', () => ({ api: {} }));

// Markdown is the expensive part of a row; count how often each body is rendered.
const rendered: string[] = [];
vi.mock('../../src/client/Markdown.js', () => ({
  Markdown: ({ text }: { text: string }) => {
    rendered.push(text);
    return text;
  },
}));

const { useStore } = await import('../../src/client/store.js');
const { CommentPanel } = await import('../../src/client/comments/CommentPanel.js');

function thread(id: string, path: string, body: string): CommentThread {
  return {
    id,
    anchor: { path, side: 'new', startLine: 1, endLine: 1, quoted: 'q' },
    messages: [{ id: `${id}-m`, author: 'human', body, createdAt: 1, updatedAt: 1 }],
    resolved: false,
    stale: false,
  };
}
const threads = [thread('t1', 'a.md', 'body a'), thread('t2', 'b.md', 'body b'), thread('t3', 'c.md', 'body c')];

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  rendered.length = 0;
  useStore.setState({ threads, showResolved: false, activePath: null });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});

describe('CommentPanel rows', () => {
  it('leave Markdown bodies alone when the active file changes', async () => {
    await act(() => root.render(createElement(CommentPanel)));
    expect(rendered.sort()).toEqual(['body a', 'body b', 'body c']);
    rendered.length = 0;
    await act(() => useStore.setState({ activePath: 'b.md' }));
    expect(host.querySelector('.copy-btn')?.getAttribute('title')).toContain('b.md');
    expect(rendered).toEqual([]);
    await act(() => useStore.setState({ activePath: 'c.md' }));
    expect(rendered).toEqual([]);
  });

  it('rerender only the thread whose object changed', async () => {
    await act(() => root.render(createElement(CommentPanel)));
    rendered.length = 0;
    const [a, b, c] = threads;
    await act(() => useStore.setState({ threads: [a!, { ...b!, messages: [{ ...b!.messages[0]!, body: 'body b2' }] }, c!] }));
    expect(rendered).toEqual(['body b2']);
  });
});
