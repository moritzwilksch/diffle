// @vitest-environment jsdom
import { Fragment, act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../../src/shared/protocol.js';

vi.mock('../../src/client/api.js', () => ({ api: {} }));

const { useStore } = await import('../../src/client/store.js');
const { FileTreePane } = await import('../../src/client/tree/FileTreePane.js');
const { TooltipHost } = await import('../../src/client/ui/Tooltip.js');

const snapshot: Snapshot = {
  root: '/r',
  mode: {
    old: 'HEAD',
    mergeBase: false,
    new: 'worktree',

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
  act(() => root.render(createElement(Fragment, null, createElement(FileTreePane), createElement(TooltipHost))));
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

describe('FileTreePane name tooltips', () => {
  // The row's name the pointer rests on, so a hover can leave it the way a browser reports.
  let under: Element | null = null;
  // jsdom lays nothing out; the tree reveals its ellipsis marker through a container query, so
  // the computed opacity stands in for "this name is truncated".
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'getComputedStyle').mockImplementation(
      (el) => ({ opacity: row('a.txt').contains(el) ? '1' : '0' }) as CSSStyleDeclaration,
    );
  });
  afterEach(() => {
    under = null;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const tip = () => document.querySelector('[role="tooltip"]');
  const hover = (path: string) => {
    const content = row(path).querySelector('[data-item-section="content"]')!;
    act(() => {
      under?.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, composed: true, relatedTarget: content }));
      content.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, composed: true, relatedTarget: under }));
      under = content;
    });
    act(() => {
      vi.advanceTimersByTime(250);
    });
  };

  it('shows the full name of an ellipsized row', () => {
    hover('a.txt');
    expect(tip()?.textContent).toBe('a.txt');
  });

  it('shows nothing for a row whose name fits', () => {
    hover('b.txt');
    expect(tip()).toBeNull();
    expect(row('b.txt').hasAttribute('title')).toBe(false);
  });

  it('moves the tip along with the pointer between rows', () => {
    hover('a.txt');
    hover('b.txt');
    expect(tip()).toBeNull();
    hover('a.txt');
    expect(tip()?.textContent).toBe('a.txt');
  });
});
