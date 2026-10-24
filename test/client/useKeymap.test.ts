// @vitest-environment jsdom
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = {
  snapshot: vi.fn(),
  threads: vi.fn(async () => []),
  viewed: vi.fn(async () => []),
  config: vi.fn(async () => ({ autoViewed: [], contextLines: 5, followRefs: 'off', lineWrap: true, lspCommands: {} })),
  saveConfig: vi.fn(async (update: object) => ({ ...useStore.getState().config, ...update })),
  lspStatus: vi.fn(async () => ({ enabled: false, servers: [], missing: [] })),
  exportComments: vi.fn(),
};
vi.mock('@/client/api.js', () => ({ api }));

const { useStore } = await import('@/client/store.js');
const { IDLE_GRAPH } = await import('@/client/connected/clusters/focus.js');
const { hasModifier, useKeymap } = await import('@/client/keyboard/useKeymap.js');

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
  it('releases local search when a diff line is clicked, preserving its draft for /', () => {
    const previous = useStore.getState().search;
    const diffStyle = useStore.getState().diffStyle;
    const input = document.createElement('input');
    input.setAttribute('data-content-search', '');
    const diff = document.createElement('div');
    const line = document.createElement('span');
    diff.attachShadow({ mode: 'open' }).appendChild(line);
    document.body.append(input, diff);
    useStore.setState({
      search: { ...previous, open: true, kind: 'text', scope: 'file', editing: true, input: 'draft' },
    });
    try {
      input.focus();
      input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
      expect(useStore.getState().search.editing).toBe(true);
      line.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
      expect(useStore.getState().search.editing).toBe(false);
      expect(document.activeElement).not.toBe(input);
      press('s');
      expect(useStore.getState().search.input).toBe('draft');
      expect(useStore.getState().diffStyle).not.toBe(diffStyle);
      press('/');
      expect(useStore.getState().search.editing).toBe(true);
      expect(useStore.getState().search.input).toBe('draft');
    } finally {
      input.remove();
      diff.remove();
      useStore.setState({ search: previous, diffStyle, scrollTarget: null });
    }
  });

  it('routes typing back to an unmounted local search instead of running diff shortcuts', () => {
    const previous = useStore.getState().search;
    const diffStyle = useStore.getState().diffStyle;
    useStore.setState({
      search: { ...previous, open: true, kind: 'text', scope: 'file', path: 'a.py', editing: true, input: 'term' },
    });
    try {
      expect(press('s').defaultPrevented).toBe(true);
      expect(useStore.getState().search.input).toBe('terms');
      expect(useStore.getState().search.path).toBe('a.py');
      expect(useStore.getState().search.focusNonce).toBe(previous.focusNonce + 1);
      expect(useStore.getState().diffStyle).toBe(diffStyle);
      expect(useStore.getState().scrollTarget?.align).toBe('start');
      press('Backspace');
      expect(useStore.getState().search.input).toBe('term');
      press('g');
      press('s');
      expect(useStore.getState().search.input).toBe('termgs');
    } finally {
      useStore.setState({ search: previous, scrollTarget: null });
    }
  });

  it('does not take typing away from other editable fields while local search is active', () => {
    const previous = useStore.getState().search;
    useStore.setState({
      search: { ...previous, open: true, kind: 'text', scope: 'file', editing: true, input: 'term' },
    });
    const input = document.createElement('textarea');
    document.body.appendChild(input);
    try {
      const event = new KeyboardEvent('keydown', { key: 's', bubbles: true, cancelable: true });
      input.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(useStore.getState().search.input).toBe('term');
    } finally {
      input.remove();
      useStore.setState({ search: previous });
    }
  });

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

  it('⌘/Ctrl+p opens filename search from an input and captures browser printing', () => {
    const tree = { openSearch: vi.fn(), getSearchValue: () => 'retained.txt' };
    const input = document.createElement('input');
    document.body.appendChild(input);
    const reached = vi.fn();
    input.addEventListener('keydown', reached);
    useStore.setState({ treeModel: tree as never, layout: { ...useStore.getState().layout, treeVisible: true } });
    try {
      for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
        const event = new KeyboardEvent('keydown', { key: 'p', ...modifier, bubbles: true, cancelable: true });
        input.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      }
      expect(tree.openSearch).toHaveBeenCalledTimes(2);
      expect(tree.openSearch).toHaveBeenLastCalledWith('retained.txt');
      expect(reached).not.toHaveBeenCalled();
    } finally {
      input.remove();
      useStore.setState({ treeModel: null });
    }
  });

  it('⌘+p waits for the hidden tree to mount before opening its search', async () => {
    useStore.setState({ treeModel: null, layout: { ...useStore.getState().layout, treeVisible: false } });
    expect(press('p', { metaKey: true }).defaultPrevented).toBe(true);
    expect(useStore.getState().layout.treeVisible).toBe(true);
    const tree = { openSearch: vi.fn(), getSearchValue: () => '' };
    useStore.setState({ treeModel: tree as never });
    await new Promise(requestAnimationFrame);
    expect(tree.openSearch).toHaveBeenCalledOnce();
    useStore.setState({ treeModel: null });
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

  it('C does nothing without a current file', () => {
    const openFileDraft = vi.fn();
    useStore.setState({ openFileDraft, selection: null, activePath: null, snapshot: null, fileView: null });
    press('C');
    expect(openFileDraft).not.toHaveBeenCalled();
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

  it('walks the open compare menu with j / k and the arrows instead of the cursor, and Enter picks the highlight', () => {
    const moveCursor = vi.fn();
    useStore.setState({ moveCursor });
    useStore.getState().setModeMenuOpen(true);
    const pane = document.createElement('form');
    pane.id = 'mode-config';
    const submit = document.createElement('button');
    pane.appendChild(submit);
    document.body.appendChild(pane);
    try {
      expect(useStore.getState().modeEntry).toBe(1);
      expect(press('k').defaultPrevented).toBe(true);
      expect(useStore.getState().modeEntry).toBe(6);
      press('j');
      press('j');
      press('ArrowDown');
      press('ArrowUp');
      expect(useStore.getState().modeEntry).toBe(2);
      expect(moveCursor).not.toHaveBeenCalled();
      press('Enter');
      expect(useStore.getState().modePane).toBe('refs');
      press('ArrowDown');
      // Enter inside the configuration pane submits it natively rather than re-picking.
      const native = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      submit.dispatchEvent(native);
      expect(native.defaultPrevented).toBe(false);
      expect(useStore.getState().modePane).toBe('refs');
      press('4');
      expect(useStore.getState().modeEntry).toBe(4);
      expect(useStore.getState().modePane).toBe('pr');
    } finally {
      pane.remove();
      useStore.getState().setModeMenuOpen(false);
    }
    press('j');
    expect(moveCursor).toHaveBeenCalledWith(1);
  });

  it('t changes the theme without jumping to the cursor line', () => {
    useStore.setState({
      selection: { id: 'diff:a.py@1', range: { start: 3, side: 'additions', end: 3, endSide: 'additions' } },
      scrollTarget: null,
      toast: null,
    });
    const before = useStore.getState().theme;
    press('t');
    expect(useStore.getState().theme).not.toBe(before);
    expect(useStore.getState().scrollTarget).toBeNull();
    expect(useStore.getState().toast).toBeNull();
  });

  it('zw saves the flipped line wrapping', async () => {
    expect(useStore.getState().config.lineWrap).toBe(true);
    press('z');
    press('w');
    await flush();
    expect(api.saveConfig).toHaveBeenCalledWith({ lineWrap: false });
    expect(useStore.getState().config.lineWrap).toBe(false);
    press('z');
    press('w');
    await flush();
    expect(useStore.getState().config.lineWrap).toBe(true);
  });

  it('repeats a chord while its prefix is held and stops on release', () => {
    const { scrollCursorTo, moveCursor } = useStore.getState();
    const scroll = vi.fn();
    const move = vi.fn();
    useStore.setState({ scrollCursorTo: scroll, moveCursor: move });
    const release = (key: string) => document.body.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
    try {
      press('z');
      press('z', { repeat: true });
      expect(scroll).not.toHaveBeenCalled();
      press('t');
      press('t', { repeat: true });
      press('b');
      expect(scroll.mock.calls).toEqual([['top'], ['top'], ['bottom']]);
      // No `zj`: a key that forms no chord with the held prefix acts alone.
      press('j');
      expect(move).toHaveBeenCalledWith(1);
      release('z');
      press('t');
      expect(scroll).toHaveBeenCalledTimes(3);
    } finally {
      useStore.setState({ scrollCursorTo, moveCursor });
    }
  });

  it('reports a failed export instead of leaving the rejection unhandled', async () => {
    api.exportComments.mockRejectedValueOnce(new Error('boom'));
    press('y');
    press('y');
    await flush();
    expect(api.exportComments).toHaveBeenCalledTimes(1);
    expect(useStore.getState().toast).toBe('Copying comments failed: boom');
  });

  describe('Connected scope chords', () => {
    const cluster = (id: string, contextTotal = 0) => ({
      id,
      label: '',
      files: [id],
      symbols: 1,
      context: [],
      contextTotal,
      links: [],
      linksTotal: 0,
    });
    const GRAPH = {
      version: 1,
      clusters: [cluster('a.ts', 3), cluster('b.ts'), cluster('c.ts')],
      unlinked: ['u.ts'],
      other: [],
    };
    const A = { kind: 'cluster', id: 'a.ts' } as const;
    const actions = () => {
      const moveCluster = vi.fn();
      const focusCluster = vi.fn();
      const toggleContext = vi.fn();
      const setTreeScope = vi.fn();
      useStore.setState({ moveCluster, focusCluster, toggleContext, setTreeScope });
      return { moveCluster, focusCluster, toggleContext, setTreeScope };
    };
    const inConnected = (focus: typeof A | { kind: 'unlinked' } | { kind: 'cluster'; id: string } = A) =>
      useStore.setState({
        treeScope: 'connected',
        graph: { status: 'ready', data: GRAPH, error: null },
        focus,
      });
    const chord = (second: string) => {
      press('g');
      const e = press(second);
      // Releasing g ends the chord, as a real keyboard does between two chords.
      document.body.dispatchEvent(new KeyboardEvent('keyup', { key: 'g', bubbles: true }));
      return e;
    };
    afterEach(() =>
      useStore.setState({
        treeScope: 'changed',
        connectedFrom: 'changed',
        graph: IDLE_GRAPH,
        focus: null,
        graphOpen: false,
      }),
    );

    it('gt and gT step the cluster focus, gc toggles context, inside Connected', () => {
      const a = actions();
      inConnected();
      expect(chord('t').defaultPrevented).toBe(true);
      expect(a.moveCluster).toHaveBeenLastCalledWith(1);
      expect(chord('T').defaultPrevented).toBe(true);
      expect(a.moveCluster).toHaveBeenLastCalledWith(-1);
      expect(chord('c').defaultPrevented).toBe(true);
      expect(a.toggleContext).toHaveBeenCalledTimes(1);
    });

    it('gt, gT and gc do nothing in Changed or All files', () => {
      const a = actions();
      for (const scope of ['changed', 'all'] as const) {
        useStore.setState({ treeScope: scope, graph: { status: 'ready', data: GRAPH, error: null }, focus: A });
        for (const k of ['t', 'T', 'c']) chord(k);
        press('2');
        chord('t');
      }
      expect(a.moveCluster).not.toHaveBeenCalled();
      expect(a.focusCluster).not.toHaveBeenCalled();
      expect(a.toggleContext).not.toHaveBeenCalled();
    });

    it('{n}gt jumps to cluster n, counted from 1 over the clusters only', () => {
      const a = actions();
      inConnected();
      press('2');
      expect(chord('t').defaultPrevented).toBe(true);
      expect(a.focusCluster).toHaveBeenLastCalledWith({ kind: 'cluster', id: 'b.ts' });
      press('1');
      chord('t');
      expect(a.focusCluster).toHaveBeenLastCalledWith(A);
      expect(a.moveCluster).not.toHaveBeenCalled();
    });

    it('{n}gt past the last cluster clamps to the last cluster, not to a bucket', () => {
      const a = actions();
      inConnected();
      press('9');
      chord('t');
      expect(a.focusCluster).toHaveBeenLastCalledWith({ kind: 'cluster', id: 'c.ts' });
    });

    it('{n}gT steps n groups back, wrapping', () => {
      const a = actions();
      inConnected();
      press('3');
      chord('T');
      expect(a.moveCluster).toHaveBeenLastCalledWith(-3);
      expect(a.focusCluster).not.toHaveBeenCalled();
    });

    it('gc lists callers only for a focused cluster that has some', () => {
      const a = actions();
      inConnected({ kind: 'cluster', id: 'b.ts' });
      expect(chord('c').defaultPrevented).toBe(true);
      inConnected({ kind: 'unlinked' });
      chord('c');
      expect(a.toggleContext).not.toHaveBeenCalled();
      inConnected(A);
      chord('c');
      expect(a.toggleContext).toHaveBeenCalledTimes(1);
    });

    it('gm opens the graph of the focused cluster, and only there', () => {
      inConnected();
      expect(chord('m').defaultPrevented).toBe(true);
      expect(useStore.getState().graphOpen).toBe(true);
      useStore.setState({ graphOpen: false });
      inConnected({ kind: 'unlinked' });
      chord('m');
      expect(useStore.getState().graphOpen).toBe(false);
      useStore.setState({ treeScope: 'changed', graph: { status: 'ready', data: GRAPH, error: null }, focus: A });
      chord('m');
      expect(useStore.getState().graphOpen).toBe(false);
      useStore.setState({ treeScope: 'connected', graph: { status: 'loading', data: null, error: null } });
      chord('m');
      expect(useStore.getState().graphOpen).toBe(false);
    });

    it('leaves the keys to the graph dialog while it is open, but Escape still reaches the store', () => {
      const moveCursor = vi.fn();
      useStore.setState({ moveCursor });
      inConnected();
      useStore.getState().setGraphOpen(true);
      for (const key of ['j', 'k', 'ArrowDown', 'ArrowLeft', 'f', '0', '+', 'h', 'l', 'Enter', ' ']) {
        expect(press(key).defaultPrevented).toBe(false);
      }
      expect(moveCursor).not.toHaveBeenCalled();
      expect(chord('t').defaultPrevented).toBe(false);
      expect(useStore.getState().graphOpen).toBe(true);

      const escape = press('Escape');
      expect(escape.defaultPrevented).toBe(false);
      expect(useStore.getState().graphOpen).toBe(false);
      press('j');
      expect(moveCursor).toHaveBeenCalledWith(1);
    });

    it('gC enters Connected from either other scope and leaves it for the scope it came from', () => {
      const a = actions();
      for (const scope of ['changed', 'all'] as const) {
        useStore.setState({ treeScope: scope });
        expect(chord('C').defaultPrevented).toBe(true);
        expect(a.setTreeScope).toHaveBeenLastCalledWith('connected');
      }
      useStore.setState({ treeScope: 'connected', connectedFrom: 'changed' });
      chord('C');
      expect(a.setTreeScope).toHaveBeenLastCalledWith('changed');
      useStore.setState({ treeScope: 'connected', connectedFrom: 'all' });
      chord('C');
      expect(a.setTreeScope).toHaveBeenLastCalledWith('all');
      expect(a.setTreeScope).toHaveBeenCalledTimes(4);
    });
  });
});
