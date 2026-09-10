// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentThread, Snapshot } from '../../src/shared/protocol.js';

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
    messages: [{ id: `${id}-m`, body, createdAt: 1, updatedAt: 1 }],
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
  useStore.setState({ threads, showResolved: false, activePath: null, deleteThread: () => Promise.resolve() });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});

describe('CommentPanel rows', () => {
  it('do not rerender on unrelated store changes', async () => {
    await act(() => root.render(createElement(CommentPanel)));
    expect(rendered.sort()).toEqual(['body a', 'body b', 'body c']);
    rendered.length = 0;
    await act(() => useStore.setState({ activePath: 'b.md' }));
    expect(rendered).toEqual([]);
    await act(() => useStore.setState({ activePath: 'c.md' }));
    expect(rendered).toEqual([]);
  });

  it('rerender only the thread whose object changed', async () => {
    await act(() => root.render(createElement(CommentPanel)));
    rendered.length = 0;
    const [a, b, c] = threads;
    await act(() =>
      useStore.setState({ threads: [a!, { ...b!, messages: [{ ...b!.messages[0]!, body: 'body b2' }] }, c!] }),
    );
    expect(rendered).toEqual(['body b2']);
  });

  it('delete a thread only on the second click, and disarm after a pause', async () => {
    vi.useFakeTimers();
    try {
      const deleteThread = vi.fn(() => Promise.resolve());
      useStore.setState({ deleteThread });
      await act(() => root.render(createElement(CommentPanel)));
      const btn = () => host.querySelector<HTMLButtonElement>('button[aria-label^="Delete this thread"]')!;
      const click = () => act(() => btn().dispatchEvent(new MouseEvent('click', { bubbles: true })));
      await click();
      expect(btn().getAttribute('aria-label')).toBe('Delete this thread? Click again to confirm');
      expect(btn().textContent).toBe('Delete?');
      expect(btn().getAttribute('aria-label')).toContain('Click again');
      expect(deleteThread).not.toHaveBeenCalled();
      await act(() => vi.advanceTimersByTime(3000));
      expect(btn().getAttribute('aria-label')).toBe('Delete this thread');
      expect(deleteThread).not.toHaveBeenCalled();
      await click();
      await click();
      expect(deleteThread).toHaveBeenCalledWith('t1');
      expect(btn().getAttribute('aria-label')).toBe('Delete this thread');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the GitHub button only when the new side is the checked-out commit', async () => {
    const post = () => host.querySelector<HTMLButtonElement>('button[title*="pending review"]');
    const snapshot = (newSha: Snapshot['newSha']): Snapshot =>
      ({ newSha, headSha: 'a'.repeat(40) }) as unknown as Snapshot;

    useStore.setState({ snapshot: snapshot('worktree') });
    await act(() => root.render(createElement(CommentPanel)));
    expect(post()).toBeNull();

    await act(() => useStore.setState({ snapshot: snapshot('a'.repeat(40)) }));
    expect(post()).not.toBeNull();
  });
});
