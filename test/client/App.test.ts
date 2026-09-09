// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/client/api.js', () => ({ connectWs: () => () => undefined }));
vi.mock('../../src/client/comments/CommentPanel.js', () => ({ CommentPanel: () => null }));
vi.mock('../../src/client/header/Header.js', () => ({ Header: () => null }));
vi.mock('../../src/client/keyboard/HelpOverlay.js', () => ({ HelpOverlay: () => null }));
vi.mock('../../src/client/keyboard/useKeymap.js', () => ({ useKeymap: () => undefined }));
vi.mock('../../src/client/review/ReviewPane.js', () => ({ ReviewPane: () => null }));
vi.mock('../../src/client/tree/FileTreePane.js', () => ({ FileTreePane: () => null }));

const { App } = await import('../../src/client/App.js');
const { useStore } = await import('../../src/client/store.js');

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useStore.setState({
    layout: { treeWidth: null, panelWidth: null, treeVisible: true, panelVisible: true },
    toast: null,
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  document.dispatchEvent(new Event('pointercancel'));
  await act(() => root.unmount());
  host.remove();
});

describe('pane resizers', () => {
  it('highlights only the resizer being dragged', async () => {
    await act(() => root.render(createElement(App)));
    const [tree, panel] = host.querySelectorAll('.resizer');

    tree!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100 }));

    expect(document.body.classList.contains('resizing')).toBe(true);
    expect(tree!.classList.contains('resizing')).toBe(true);
    expect(panel!.classList.contains('resizing')).toBe(false);

    document.dispatchEvent(new Event('pointerup'));
    expect(document.body.classList.contains('resizing')).toBe(false);
    expect(tree!.classList.contains('resizing')).toBe(false);
  });
});
