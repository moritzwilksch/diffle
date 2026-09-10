// @vitest-environment jsdom
import { createElement, forwardRef, useImperativeHandle } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../../src/shared/protocol.js';
import type { CodeViewOptions } from '@pierre/diffs';
import { reviewGeometry } from '../../src/client/review/geometry.js';

const api = {
  snapshot: vi.fn(),
  threads: vi.fn(async () => []),
  viewed: vi.fn(async () => []),
  setViewed: vi.fn(async (path: string, blob: string, viewed: boolean) => [{ path, blob, viewed }]),
  config: vi.fn(async () => ({ autoViewed: [], contextLines: 5, lspCommands: {} })),
  lspStatus: vi.fn(async () => ({ enabled: false, servers: [], missing: [] })),
  file: vi.fn(),
  patch: vi.fn(),
  patchAll: vi.fn(),
  search: vi.fn(),
};
vi.mock('../../src/client/api.js', () => ({ api }));

// The real viewer needs a layout engine; a stub that hands out the scroller and a fixed set of rendered
// rows is enough to see which element the pane's effects bound to.
type Rendered = { id: string; element: HTMLElement; type: 'diff' };
let rendered: Rendered[] = [];
const captureOptions = vi.fn<(options: CodeViewOptions<unknown>) => void>();
vi.mock('@pierre/diffs/react', () => ({
  CodeView: forwardRef(function CodeView(
    props: {
      containerRef: (el: HTMLDivElement | null) => void;
      className: string;
      items: { id: string }[];
      options: CodeViewOptions<unknown>;
      renderHeaderMetadata: (item: { id: string }) => unknown;
    },
    ref,
  ) {
    captureOptions(props.options);
    useImperativeHandle(ref, () => ({
      getInstance: () => ({ getRenderedItems: () => rendered, render: () => {} }),
      getItem: (id: string) => rendered.find((r) => r.id === id)?.element ?? null,
      scrollTo: () => {},
    }));
    // Each item's header metadata renders in the light DOM so tests can see the header's buttons.
    return createElement(
      'div',
      { ref: props.containerRef, className: props.className },
      props.items.map((it) =>
        createElement(
          'div',
          { key: it.id, className: 'header', 'data-diffs-header': 'default' },
          createElement('span', { className: 'filename' }, it.id),
          props.renderHeaderMetadata(it) as never,
        ),
      ),
    );
  }),
}));

const installSearchHighlights = vi.fn<(viewer: () => unknown, scroller: HTMLElement) => () => void>(() => () => {});
vi.mock('../../src/client/search/highlight.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/client/search/highlight.js')>()),
  installSearchHighlights,
}));

const { useStore } = await import('../../src/client/store.js');
const { ReviewPane } = await import('../../src/client/review/ReviewPane.js');

function snap(changed: Snapshot['changed']): Snapshot {
  return {
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
    changed,
    tree: ['a.txt'],
  };
}
const changed = [
  { path: 'a.txt', status: 'M' as const, additions: 1, deletions: 0, binary: false, blob: 'b1', generated: false },
];

const box = (el: HTMLElement, top: number, bottom: number) => {
  el.getBoundingClientRect = () => ({
    top,
    bottom,
    height: bottom - top,
    left: 0,
    right: 800,
    width: 800,
    x: 0,
    y: top,
    toJSON: () => ({}),
  });
};
const flush = () => act(() => new Promise((r) => setTimeout(r, 30)));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  installSearchHighlights.mockClear();
  rendered = [];
  useStore.setState({
    snapshot: null,
    loaded: {},
    fileView: null,
    error: null,
    activePath: null,
    selection: null,
    scrollTarget: null,
    gens: {},
    collapsed: {},
    viewed: [],
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  document.documentElement.style.removeProperty('font-size');
});

describe('ReviewPane scroller effects', () => {
  it('uses the rendered header height for navigation and the same geometry for CSS and virtualization', async () => {
    document.documentElement.style.fontSize = '14.4px';
    await act(() => root.render(createElement(ReviewPane)));
    await act(() => useStore.setState({ snapshot: snap(changed) }));
    const geometry = reviewGeometry(14.4);
    const viewerOptions = captureOptions.mock.calls.at(-1)![0];
    expect(viewerOptions.itemMetrics).toEqual(geometry.itemMetrics);
    expect(viewerOptions.layout).toEqual(geometry.layout);
    expect(viewerOptions.unsafeCSS).toContain(geometry.css);
    expect(viewerOptions.hunkSeparators).toBe('line-info');

    const scroller = host.querySelector<HTMLDivElement>('.codeview')!;
    box(scroller, 0, 800);
    scroller.scrollTop = 500;
    const card = document.createElement('div');
    const row = document.createElement('div');
    row.dataset.line = '62';
    box(row, 36, 54);
    card.appendChild(row);
    rendered = [{ id: 'diff:a.txt@0', element: card, type: 'diff' }];
    await act(() =>
      useStore.setState({ scrollTarget: { id: 'diff:a.txt@0', line: 62, side: 'new', align: 'nearest', nonce: 1 } }),
    );
    expect(scroller.scrollTop).toBe(497);
  });

  it('bind to the viewer that mounts after the empty-changes branch, and again after a theme remount', async () => {
    await act(() => root.render(createElement(ReviewPane)));
    await act(() => useStore.setState({ snapshot: snap([]) }));
    expect(host.textContent).toMatch(/No changes/);
    expect(installSearchHighlights).not.toHaveBeenCalled();

    // The first save on a clean tree: the snapshot object changes but stays non-null.
    await act(() => useStore.setState({ snapshot: snap(changed) }));
    const scroller = host.querySelector<HTMLDivElement>('.codeview')!;
    expect(scroller).not.toBeNull();
    expect(installSearchHighlights).toHaveBeenCalledTimes(1);
    expect(installSearchHighlights.mock.calls[0]![1]).toBe(scroller);

    // Wheel scrolling moves the tree's selected row to the file under the eye.
    const row = document.createElement('div');
    box(row, 100, 300);
    box(scroller, 0, 800);
    rendered = [{ id: 'diff:a.txt@0', element: row, type: 'diff' }];
    scroller.dispatchEvent(new Event('scroll'));
    await flush();
    expect(useStore.getState().activePath).toBe('a.txt');

    // A theme toggle remounts the viewer under a new scroller; the effects follow it.
    await act(() => useStore.setState({ activePath: null, theme: 'dark' }));
    const remounted = host.querySelector<HTMLDivElement>('.codeview')!;
    expect(remounted).not.toBe(scroller);
    expect(installSearchHighlights).toHaveBeenLastCalledWith(expect.any(Function), remounted);
    box(remounted, 0, 800);
    remounted.dispatchEvent(new Event('scroll'));
    await flush();
    expect(useStore.getState().activePath).toBe('a.txt');
  });

  it('keeps the active file while it is on screen, even when another file sits at the gaze point', async () => {
    const two = [
      ...changed,
      { path: 'b.txt', status: 'M' as const, additions: 1, deletions: 0, binary: false, blob: 'b2', generated: true },
    ];
    await act(() => root.render(createElement(ReviewPane)));
    await act(() =>
      useStore.setState({ snapshot: { ...snap(two), tree: ['a.txt', 'b.txt'] }, activePath: 'b.txt', selection: null }),
    );
    const scroller = host.querySelector<HTMLDivElement>('.codeview')!;
    box(scroller, 0, 800);
    // J landed b.txt's collapsed header at the top; a.txt fills the rest of the viewport, gaze point included.
    const header = document.createElement('div');
    box(header, 10, 54);
    const body = document.createElement('div');
    box(body, 60, 2000);
    rendered = [
      { id: 'diff:b.txt@0', element: header, type: 'diff' },
      { id: 'diff:a.txt@0', element: body, type: 'diff' },
    ];
    scroller.dispatchEvent(new Event('scroll'));
    await flush();
    expect(useStore.getState().activePath).toBe('b.txt');
    // Once the header has scrolled away, the file at the gaze point takes over.
    box(header, -100, -56);
    scroller.dispatchEvent(new Event('scroll'));
    await flush();
    expect(useStore.getState().activePath).toBe('a.txt');
  });

  it('leaves the active file alone while a line is focused, even when the cursor has scrolled off screen', async () => {
    const two = [
      ...changed,
      { path: 'b.txt', status: 'M' as const, additions: 1, deletions: 0, binary: false, blob: 'b2', generated: true },
    ];
    await act(() => root.render(createElement(ReviewPane)));
    const selection = { id: 'diff:b.txt@0', lineNumber: 1, side: 'additions' } as unknown as NonNullable<
      ReturnType<typeof useStore.getState>['selection']
    >;
    await act(() =>
      useStore.setState({ snapshot: { ...snap(two), tree: ['a.txt', 'b.txt'] }, activePath: 'b.txt', selection }),
    );
    const scroller = host.querySelector<HTMLDivElement>('.codeview')!;
    box(scroller, 0, 800);
    // The cursor's file has scrolled away; a.txt fills the viewport, gaze point included.
    const gone = document.createElement('div');
    box(gone, -500, -100);
    const body = document.createElement('div');
    box(body, -90, 2000);
    rendered = [
      { id: 'diff:b.txt@0', element: gone, type: 'diff' },
      { id: 'diff:a.txt@0', element: body, type: 'diff' },
    ];
    scroller.dispatchEvent(new Event('scroll'));
    await flush();
    expect(useStore.getState().activePath).toBe('b.txt');
  });

  it('scrolls a cursor row back into the pane when the viewer left it past the bottom edge', async () => {
    await act(() => root.render(createElement(ReviewPane)));
    await act(() => useStore.setState({ snapshot: snap(changed), activePath: 'a.txt' }));
    const scroller = host.querySelector<HTMLDivElement>('.codeview')!;
    box(scroller, 0, 800);
    scroller.scrollTop = 500;
    // The viewer's scrollTo is a no-op here, standing in for a 'nearest' it judged unnecessary; the
    // rendered row for line 62 sits 30px below the pane's bottom edge.
    const card = document.createElement('div');
    box(card, 100, 2000);
    const row = document.createElement('div');
    row.dataset.line = '62';
    box(row, 812, 830);
    card.appendChild(row);
    rendered = [{ id: 'diff:a.txt@0', element: card, type: 'diff' }];
    const sel = {
      id: 'diff:a.txt@0',
      range: { start: 62, side: 'additions', end: 62, endSide: 'additions' },
    } as unknown as NonNullable<ReturnType<typeof useStore.getState>['selection']>;
    await act(() =>
      useStore.setState({
        selection: sel,
        scrollTarget: { id: 'diff:a.txt@0', line: 62, side: 'new', align: 'nearest', nonce: 1 },
      }),
    );
    await flush();
    expect(scroller.scrollTop).toBe(530);
    // A row already inside the pane is left alone.
    box(row, 400, 418);
    await act(() =>
      useStore.setState({ scrollTarget: { id: 'diff:a.txt@0', line: 62, side: 'new', align: 'nearest', nonce: 2 } }),
    );
    await flush();
    expect(scroller.scrollTop).toBe(530);
  });

  it('bind after an error banner gives way to a snapshot', async () => {
    await act(() => root.render(createElement(ReviewPane)));
    await act(() => useStore.setState({ snapshot: snap(changed), error: 'bad revision' }));
    expect(host.textContent).toMatch(/bad revision/);
    expect(installSearchHighlights).not.toHaveBeenCalled();
    await act(() => useStore.setState({ error: null }));
    expect(installSearchHighlights).toHaveBeenCalledTimes(1);
    expect(installSearchHighlights.mock.calls[0]![1]).toBe(host.querySelector('.codeview'));
  });

  it('toggles collapse from the file header while only the checkbox changes viewed state', async () => {
    await act(() => root.render(createElement(ReviewPane)));
    const file = { kind: 'file' as const, file: { name: 'a.txt', contents: 'x' } };
    await act(() => useStore.setState({ snapshot: snap(changed), loaded: { 'a.txt': file } }));
    const header = host.querySelector<HTMLElement>('[data-diffs-header]')!;

    await act(() => header.querySelector<HTMLElement>('.filename')!.click());
    expect(useStore.getState().collapsed['a.txt']).toBe(true);
    expect(useStore.getState().viewed).toEqual([]);

    await act(() => header.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    expect(useStore.getState().collapsed['a.txt']).toBe(true);
    expect(useStore.getState().viewed).toMatchObject([{ path: 'a.txt', blob: 'b1', viewed: true }]);
  });

  it('shows the viewed shortcut in the file header tooltip', async () => {
    await act(() => root.render(createElement(ReviewPane)));
    const file = { kind: 'file' as const, file: { name: 'a.txt', contents: 'x' } };
    await act(() => useStore.setState({ snapshot: snap(changed), loaded: { 'a.txt': file } }));
    expect(host.querySelector('[title="Mark as viewed and collapse the file (v)"]')).not.toBeNull();
  });

  it('offers one way back from the file view: the bar above, not the file header too', async () => {
    await act(() => root.render(createElement(ReviewPane)));
    const file = { kind: 'file' as const, file: { name: 'a.txt', contents: 'x' } };
    await act(() => useStore.setState({ snapshot: snap(changed), loaded: { 'a.txt': file } }));
    expect(host.querySelectorAll('[title="View full file (F)"]')).toHaveLength(1);
    expect(host.querySelectorAll('[title^="Back to the diff"]')).toHaveLength(0);

    await act(() =>
      useStore.setState({
        fileView: { path: 'a.txt', external: false, item: file, from: { position: null, activePath: null } },
      }),
    );
    expect(host.querySelectorAll('[title^="Back to the diff"]')).toHaveLength(1);
    expect(host.querySelectorAll('[title="View full file (F)"]')).toHaveLength(0);
    expect(host.querySelector('[title="Collapse / expand"]')).toBeNull();
    const collapsed = useStore.getState().collapsed;
    await act(() => host.querySelector<HTMLElement>('[data-diffs-header] .filename')!.click());
    expect(useStore.getState().collapsed).toBe(collapsed);

    await act(() => useStore.setState({ fileView: null }));
    expect(host.querySelector('[title="Collapse / expand"]')).not.toBeNull();
    await act(() => host.querySelector<HTMLElement>('[data-diffs-header] .filename')!.click());
    expect(useStore.getState().collapsed['a.txt']).toBe(true);
  });
});
