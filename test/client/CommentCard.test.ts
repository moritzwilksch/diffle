// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentThread, GithubMetadata } from '../../src/shared/protocol.js';

const api = { exportComment: vi.fn() };
const copyText = vi.fn();
vi.mock('../../src/client/api.js', () => ({ api }));
vi.mock('../../src/client/clipboard.js', () => ({ copyText }));
vi.mock('../../src/client/Markdown.js', () => ({ Markdown: ({ text }: { text: string }) => text }));

const { useStore } = await import('../../src/client/store.js');
const { CommentCard } = await import('../../src/client/review/CommentCard.js');

const thread: CommentThread = {
  id: 'thread-1',
  anchor: { path: 'src/a.ts', side: 'new', startLine: 4, endLine: 4, quoted: 'const a = 1;' },
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
  copyText.mockReset();
  useStore.setState({ editingId: null, replyTo: null, focusedThread: null, github: null });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});

describe('CommentCard GitHub button', () => {
  const metadata = (canExport: boolean): GithubMetadata => ({ canExport }) as GithubMetadata;
  const post = () => host.querySelector<HTMLButtonElement>('button[title*="pending review"]');

  it('is hidden without export eligibility', async () => {
    useStore.setState({ github: metadata(false) });
    await act(() => root.render(createElement(CommentCard, { thread })));
    expect(post()).toBeNull();
  });

  it('is shown when export is eligible', async () => {
    useStore.setState({ github: metadata(true) });
    await act(() => root.render(createElement(CommentCard, { thread })));
    expect(post()).not.toBeNull();
  });
});

describe('CommentCard copy buttons', () => {
  it('copies one message in the server-generated prompt format', async () => {
    const prompt = 'src/a.ts:4\n\n> const a = 1;\n\nSecond\n\n---\n';
    api.exportComment.mockResolvedValue(prompt);
    copyText.mockResolvedValue(true);
    await act(() => root.render(createElement(CommentCard, { thread })));

    const buttons = host.querySelectorAll<HTMLButtonElement>('button[title="Copy this comment as a prompt"]');
    expect(buttons).toHaveLength(2);
    await act(() => buttons[1]!.click());

    expect(api.exportComment).toHaveBeenCalledWith('thread-1', 'message-2');
    expect(copyText).toHaveBeenCalledWith(prompt);
  });
});
