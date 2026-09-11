// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GithubMetadata, Snapshot } from '../../src/shared/protocol.js';

vi.mock('../../src/client/api.js', () => ({ api: { github: () => new Promise(() => {}) } }));
const { useStore } = await import('../../src/client/store.js');
const { GithubMenu } = await import('../../src/client/header/GithubMenu.js');
const { useKeymap } = await import('../../src/client/keyboard/useKeymap.js');
function App() {
  useKeymap();
  return createElement(GithubMenu);
}
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useStore.setState({
    snapshot: {} as Snapshot,
    githubMenuOpen: false,
    github: { status: 'loading' },
    modeMenuOpen: false,
    helpOpen: false,
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});
const press = (key: string) =>
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

it('o opens repository information during lookup; Escape and outside clicks dismiss it', async () => {
  await act(() => root.render(createElement(App)));
  await act(() => press('o'));
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  expect(host.textContent).toContain('Loading…');
  expect(host.textContent).not.toContain('No GitHub origin');
  await act(() => press('Escape'));
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  await act(() => host.querySelector('button')!.click());
  await act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  expect(host.querySelector('[role="dialog"]')).toBeNull();
});

it('shows PR metadata from another repository and separates draft, open, closed, and merged', async () => {
  const metadata: GithubMetadata = {
    version: 1,
    repository: 'alice/fork',
    reason: 'The comparison does not match the pull request diff',
    pullRequest: {
      repository: 'upstream/project',
      number: 42,
      title: 'Improve parsing',
      url: 'https://github.com/upstream/project/pull/42',
      state: 'OPEN',
      isDraft: true,
    },
  };
  useStore.setState({ githubMenuOpen: true, github: { status: 'ready', data: metadata } });
  await act(() => root.render(createElement(App)));
  expect(host.textContent).toContain('#42 Improve parsing');
  expect(host.textContent).toContain('upstream/project');
  expect(host.textContent).toContain('Draft');
  expect(host.textContent).toContain(metadata.reason);
  for (const [state, label] of [
    ['OPEN', 'Open'],
    ['CLOSED', 'Closed'],
    ['MERGED', 'Merged'],
  ] as const) {
    await act(() =>
      useStore.setState({
        github: {
          status: 'ready',
          data: { ...metadata, pullRequest: { ...metadata.pullRequest!, state, isDraft: false } },
        },
      }),
    );
    expect(host.textContent).toContain(label);
  }
  await act(() =>
    useStore.setState({
      github: {
        status: 'ready',
        data: { ...metadata, pullRequest: null, reason: 'Lookup failed: gh is not installed' },
      },
    }),
  );
  expect(host.textContent).toContain('Lookup failed: gh is not installed');
  expect(host.textContent).toContain('alice/fork');
  expect(host.querySelector('a')?.href).toBe('https://github.com/alice/fork');
});
