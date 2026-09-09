// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../../src/shared/protocol.js';

vi.mock('../../src/client/api.js', () => ({ api: {} }));

const { useStore } = await import('../../src/client/store.js');
const { FileTreePane } = await import('../../src/client/tree/FileTreePane.js');

const snapshot: Snapshot = {
  root: '/r',
  mode: {
    kind: 'working',
    request: { kind: 'working' },
    old: { kind: 'rev', rev: 'HEAD' },
    newRev: 'worktree',
    label: 'working',
    live: 'none',
    commentKey: 'working',
  },
  version: 1,
  oldSha: 'x',
  newSha: 'worktree',
  headSha: 'h',
  context: 5,
  tree: ['a.txt', 'b.txt'],
  changed: ['a.txt', 'b.txt'].map((path) => ({
    path,
    status: 'M' as const,
    additions: 1,
    deletions: 0,
    binary: false,
    blob: `blob-${path}`,
    generated: false,
  })),
};

let root: Root;
let host: HTMLDivElement;
const openFile = vi.fn(() => Promise.resolve());
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  openFile.mockClear();
  useStore.setState({
    snapshot,
    activePath: 'a.txt',
    collapsed: { 'a.txt': true, 'b.txt': true },
    viewed: [],
    config: { autoViewed: [], contextLines: 5, lspCommands: {} },
    loaded: {},
    openFile,
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(createElement(FileTreePane)));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

// The tree renders its rows in a shadow root.
function row(path: string): HTMLElement {
  for (const el of host.querySelectorAll('*')) {
    const found = el.shadowRoot?.querySelector<HTMLElement>(`[data-item-type="file"][data-item-path="${path}"]`);
    if (found) return found;
  }
  throw new Error(`no row for ${path}`);
}

function click(path: string) {
  act(() => {
    row(path).dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
  });
}

describe('FileTreePane clicks', () => {
  it('clicking the already-active collapsed file expands and opens it', () => {
    click('a.txt');
    expect(useStore.getState().collapsed['a.txt']).toBe(false);
    expect(openFile.mock.calls).toEqual([['a.txt']]);
  });

  it('clicking another collapsed file expands and opens it once through the selection change', () => {
    click('b.txt');
    expect(useStore.getState().collapsed['b.txt']).toBe(false);
    expect(openFile.mock.calls).toEqual([['b.txt']]);
  });
});
