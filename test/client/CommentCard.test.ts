// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentThread, GithubMetadata } from '@/shared/protocol.js';

const api = { exportComment: vi.fn() };
// The browser's clipboard, so the copy button's own acknowledgement runs as in a page.
const writeText = vi.fn();
Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
vi.mock('@/client/api.js', () => ({ api }));
vi.mock('@/client/Markdown.js', () => ({ Markdown: ({ text }: { text: string }) => text }));

const { useStore } = await import('@/client/store.js');
const { CommentCard } = await import('@/client/review/CommentCard.js');

const thread: CommentThread = {
  id: 'thread-1',
  anchor: { kind: 'line', path: 'src/a.ts', side: 'new', startLine: 4, endLine: 4, quoted: 'const a = 1;' },
  messages: [
    { id: 'message-1', body: 'First', createdAt: 1, updatedAt: 1 },
    { id: 'message-2', body: 'Second', createdAt: 2, updatedAt: 2 },
  ],
  resolved: false,
  stale: false,
};

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  api.exportComment.mockReset();
  writeText.mockReset();
  useStore.setState({ editingId: null, replyTo: null, focusedThread: null, github: { status: 'idle' } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});

describe('CommentCard GitHub button', () => {
  const metadata = (reason: string | null): GithubMetadata => ({ reason }) as GithubMetadata;
  const post = () => host.querySelector<HTMLButtonElement>('button[title*="pending review"]');

  it('shows only when export is eligible', async () => {
    useStore.setState({ github: { status: 'ready', data: metadata('No matching pull request') } });
    await act(() => root.render(createElement(CommentCard, { thread })));
    expect(post()).toBeNull();
    await act(() => useStore.setState({ github: { status: 'ready', data: metadata(null) } }));
    expect(post()).not.toBeNull();
  });
});

describe('CommentCard copy buttons', () => {
  it('copies one message in the server-generated prompt format', async () => {
    const prompt = 'src/a.ts:4\n\n> const a = 1;\n\nSecond\n\n---\n';
    api.exportComment.mockResolvedValue(prompt);
    writeText.mockResolvedValue(undefined);
    await act(() => root.render(createElement(CommentCard, { thread })));

    const buttons = host.querySelectorAll<HTMLButtonElement>('button[title="Copy this comment as a prompt"]');
    expect(buttons).toHaveLength(2);
    await act(() => buttons[1]!.click());

    expect(api.exportComment).toHaveBeenCalledWith('thread-1', 'message-2');
    expect(writeText).toHaveBeenCalledWith(prompt);
  });
});
