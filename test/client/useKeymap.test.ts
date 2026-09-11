// @vitest-environment jsdom
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = {
  snapshot: vi.fn(),
  threads: vi.fn(async () => []),
  viewed: vi.fn(async () => []),
  config: vi.fn(async () => ({ autoViewed: [], contextLines: 5, lspCommands: {} })),
  lspStatus: vi.fn(async () => ({ enabled: false, servers: [], missing: [] })),
  exportComments: vi.fn(),
};
vi.mock('../../src/client/api.js', () => ({ api }));

const { useStore } = await import('../../src/client/store.js');
const { hasModifier, useKeymap } = await import('../../src/client/keyboard/useKeymap.js');

function Keys() {
  useKeymap();
  return null;
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(createElement(Keys)));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const press = (key: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  document.body.dispatchEvent(e);
  return e;
};
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('hasModifier', () => {
  const ev = (key: string, init: KeyboardEventInit) => new KeyboardEvent('keydown', { key, ...init });
  it('sees plain and Ctrl/Alt-chorded keys as they are', () => {
    expect(hasModifier(ev('j', {}))).toBe(false);
    expect(hasModifier(ev('j', { ctrlKey: true }))).toBe(true);
    expect(hasModifier(ev('j', { altKey: true }))).toBe(true);
  });
  it('looks through AltGr for printable characters only', () => {
    expect(hasModifier(ev(']', { ctrlKey: true, altKey: true }))).toBe(false);
    expect(hasModifier(ev('#', { modifierAltGraph: true }))).toBe(false);
    expect(hasModifier(ev('#', { altKey: true, modifierAltGraph: true }))).toBe(false);
    expect(hasModifier(ev('Delete', { ctrlKey: true, altKey: true }))).toBe(true);
  });
});

describe('useKeymap', () => {
  it('runs a key typed through AltGr (Windows Ctrl+Alt, Linux AltGraph) like an unmodified one', () => {
    const moveHunk = vi.fn();
    useStore.setState({ moveHunk });
    const e1 = press(']', { ctrlKey: true, altKey: true });
    expect(moveHunk).toHaveBeenCalledWith(1);
    expect(e1.defaultPrevented).toBe(true);
    press('[', { modifierAltGraph: true });
    expect(moveHunk).toHaveBeenLastCalledWith(-1);
    expect(moveHunk).toHaveBeenCalledTimes(2);
  });

  it('still leaves Ctrl- and Alt-chorded keys to the browser', () => {
    const moveHunk = vi.fn();
    useStore.setState({ moveHunk });
    press(']', { ctrlKey: true });
    press(']', { altKey: true });
    expect(moveHunk).not.toHaveBeenCalled();
  });

  it('stops a handled key at the document, so the viewer never sees it as an interruption of its scroll', () => {
    useStore.setState({ moveCursor: vi.fn(), moveFile: vi.fn() });
    const reached = vi.fn();
    document.body.addEventListener('keydown', reached);
    try {
      press('j');
      press('J');
      expect(reached).not.toHaveBeenCalled();
      press('Tab');
      expect(reached).toHaveBeenCalledTimes(1);
    } finally {
      document.body.removeEventListener('keydown', reached);
    }
  });

  it('/ opens the file-scoped search, g/ the widened one, and gf the tree filter', () => {
    const openSearch = vi.fn();
    const tree = { openSearch: vi.fn() };
    useStore.setState({ openSearch, treeModel: tree as never });
    try {
      press('/');
      expect(openSearch).toHaveBeenLastCalledWith('file');
      useStore.setState({ search: { ...useStore.getState().search, scope: 'file' } });
      press('g');
      press('/');
      expect(openSearch).toHaveBeenLastCalledWith('diff');
      useStore.setState({ search: { ...useStore.getState().search, scope: 'repo' } });
      press('g');
      press('/');
      expect(openSearch).toHaveBeenLastCalledWith('repo');
      expect(tree.openSearch).not.toHaveBeenCalled();
      press('g');
      press('f');
      expect(tree.openSearch).toHaveBeenCalledTimes(1);
    } finally {
      useStore.setState({ treeModel: null });
    }
  });

  it('⌘/Ctrl+Shift+e focuses the file tree on the active file, showing the tree first when it is hidden', async () => {
    const tree = { getItem: vi.fn(() => ({})), focusPath: vi.fn(), focusNearestPath: vi.fn() };
    useStore.setState({
      treeModel: tree as never,
      activePath: 'a.py',
      layout: { ...useStore.getState().layout, treeVisible: false },
    });
    try {
      for (const init of [
        { metaKey: true, shiftKey: true },
        { ctrlKey: true, shiftKey: true },
      ]) {
        tree.focusPath.mockClear();
        expect(press('e', init).defaultPrevented).toBe(true);
        await new Promise((r) => requestAnimationFrame(r));
        expect(tree.focusPath).toHaveBeenCalledWith('a.py');
      }
      expect(useStore.getState().layout.treeVisible).toBe(true);
      // Without Shift, the chord is the browser's.
      expect(press('e', { metaKey: true }).defaultPrevented).toBe(false);
    } finally {
      useStore.setState({ treeModel: null });
    }
  });

  it('zz, zt and zb ask the store to scroll the cursor line, not to move it', () => {
    const scrollCursorTo = vi.fn();
    const moveCursor = vi.fn();
    useStore.setState({ scrollCursorTo, moveCursor });
    press('z');
    press('z');
    expect(scrollCursorTo).toHaveBeenLastCalledWith('eye');
    press('z');
    press('t');
    expect(scrollCursorTo).toHaveBeenLastCalledWith('top');
    press('z');
    press('b');
    expect(scrollCursorTo).toHaveBeenLastCalledWith('bottom');
    expect(scrollCursorTo).toHaveBeenCalledTimes(3);
    expect(moveCursor).not.toHaveBeenCalled();
  });

  it('C comments on the current file as a whole, c on the selection', () => {
    const openDraft = vi.fn();
    const openFileDraft = vi.fn();
    const sel = {
      id: 'diff:b.py@0',
      range: { start: 2, side: 'additions' as const, end: 2, endSide: 'additions' as const },
    };
    useStore.setState({ openDraft, openFileDraft, selection: sel, activePath: 'b.py' });
    press('C');
    expect(openFileDraft).toHaveBeenCalledWith('b.py');
    press('c');
    expect(openDraft).toHaveBeenCalledWith(sel);
    useStore.setState({ selection: null, activePath: null, snapshot: null, fileView: null });
    press('C');
    expect(openFileDraft).toHaveBeenCalledTimes(1);
  });

  it('0 and $ focus the first / last symbol of the cursor line and say so when there is none', () => {
    useStore.setState({
      selection: { id: 'diff:a.py@0', range: { start: 3, side: 'additions', end: 3, endSide: 'additions' } },
      toast: null,
    });
    // No viewer is mounted in this test, so the line has no rendered words.
    press('$');
    expect(useStore.getState().toast).toBe('No symbol on this line');
    useStore.setState({ toast: null });
    press('0');
    expect(useStore.getState().toast).toBe('No symbol on this line');
    useStore.setState({ selection: null, toast: null });
    press('0');
    expect(useStore.getState().toast).toBeNull();
  });

  it('a count before gg or G jumps to that line', () => {
    const goToLine = vi.fn(async () => {});
    const moveFile = vi.fn();
    useStore.setState({ goToLine, moveFile });
    // Digits are swallowed (no browser default); the first g only starts the chord.
    for (const k of ['1', '2', '0']) expect(press(k).defaultPrevented).toBe(true);
    press('g');
    expect(press('g').defaultPrevented).toBe(true);
    expect(goToLine).toHaveBeenLastCalledWith(120);
    press('7');
    press('G');
    expect(goToLine).toHaveBeenLastCalledWith(7);
    expect(moveFile).not.toHaveBeenCalled();
    // Without a count the same chords act on files.
    press('g');
    press('g');
    expect(moveFile).toHaveBeenLastCalledWith('first');
    expect(goToLine).toHaveBeenCalledTimes(2);
  });

  it('a count before j, k or the arrows walks that many lines; one key drops it', () => {
    const moveCursorBy = vi.fn();
    const moveCursor = vi.fn();
    const moveFile = vi.fn();
    useStore.setState({ moveCursorBy, moveCursor, moveFile });
    press('1');
    press('0');
    press('j');
    expect(moveCursorBy).toHaveBeenLastCalledWith(10);
    press('3');
    press('k');
    expect(moveCursorBy).toHaveBeenLastCalledWith(-3);
    press('4');
    expect(press('ArrowDown').defaultPrevented).toBe(true);
    expect(moveCursorBy).toHaveBeenLastCalledWith(4);
    press('2');
    press('ArrowUp');
    expect(moveCursorBy).toHaveBeenLastCalledWith(-2);
    expect(moveCursor).not.toHaveBeenCalled();
    // A count is spent by the key it precedes, whether or not that key takes one.
    press('5');
    press('J');
    press('j');
    press('ArrowDown');
    expect(moveFile).toHaveBeenCalledWith(1);
    expect(moveCursor).toHaveBeenCalledTimes(2);
    expect(moveCursorBy).toHaveBeenCalledTimes(4);
  });

  it('t re-anchors the cursor line after the theme change remounts the viewer', () => {
    useStore.setState({
      selection: { id: 'diff:a.py@1', range: { start: 3, side: 'additions', end: 3, endSide: 'additions' } },
      scrollTarget: null,
      toast: null,
    });
    press('t');
    expect(useStore.getState().scrollTarget).toEqual(
      expect.objectContaining({ id: 'diff:a.py@1', line: 3, align: 'eye' }),
    );
    useStore.setState({ selection: null, scrollTarget: null });
    press('t');
    expect(useStore.getState().scrollTarget).toBeNull();
    expect(useStore.getState().toast).toBeNull();
  });

  it('reports a failed export instead of leaving the rejection unhandled', async () => {
    api.exportComments.mockRejectedValueOnce(new Error('boom'));
    press('y');
    press('y');
    await flush();
    expect(api.exportComments).toHaveBeenCalledTimes(1);
    expect(useStore.getState().toast).toBe('Copying comments failed: boom');
  });
});
