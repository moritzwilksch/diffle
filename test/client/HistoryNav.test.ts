// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/client/api.js', () => ({ api: {} }));

const { useStore } = await import('../../src/client/store.js');
const { HistoryNav } = await import('../../src/client/header/HistoryNav.js');

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useStore.setState({ jumps: [], jumpIndex: 0, fileView: null });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});

const back = () => host.querySelector<HTMLButtonElement>('button[aria-label="Back"]')!;
const forward = () => host.querySelector<HTMLButtonElement>('button[aria-label="Forward"]')!;
const render = () => act(() => root.render(createElement(HistoryNav)));

describe('HistoryNav', () => {
  it('is always in place, greyed out until a jump leaves somewhere to come back to', async () => {
    await render();
    expect(back().disabled).toBe(true);
    expect(forward().disabled).toBe(true);
  });

  it('enables back at older jumplist positions and forward at newer ones', async () => {
    const jumps = [
      { path: 'a.py', side: 'new' as const, line: 1 },
      { path: 'b.py', side: 'new' as const, line: 2 },
      { path: 'c.py', side: 'new' as const, line: 3 },
    ];
    // Just after a jump: at the newest position, back only.
    useStore.setState({ jumps, jumpIndex: jumps.length });
    await render();
    expect(back().disabled).toBe(false);
    expect(forward().disabled).toBe(true);

    // Walked back into the list: both ways are open.
    await act(() => useStore.setState({ jumpIndex: 1 }));
    expect(back().disabled).toBe(false);
    expect(forward().disabled).toBe(false);

    // At the oldest position: forward only.
    await act(() => useStore.setState({ jumpIndex: 0 }));
    expect(back().disabled).toBe(true);
    expect(forward().disabled).toBe(false);
  });

  it('enables back in a full-file view even with an empty jumplist, worded neutrally', async () => {
    useStore.setState({
      fileView: { path: 'a.py', external: false, item: null, from: { position: null, activePath: null } },
    });
    await render();
    expect(back().disabled).toBe(false);
    expect(forward().disabled).toBe(true);
    // A jump back may lead to another full file, so the labels promise no diff.
    expect(back().title).toBe('Back (Ctrl+o)');
    expect(forward().title).toBe('Forward (Ctrl+i)');

    // The buttons are the keyboard's share of the same navigation.
    const jumpBack = vi.fn();
    const jumpForward = vi.fn();
    await act(() => useStore.setState({ jumpBack, jumpForward }));
    await act(() => back().click());
    expect(jumpBack).toHaveBeenCalledOnce();
    expect(jumpForward).not.toHaveBeenCalled();
  });

  it('walks the jumplist forward again on the forward button', async () => {
    const jumps = [
      { path: 'a.py', side: 'new' as const, line: 1 },
      { path: 'b.py', side: 'new' as const, line: 2 },
      { path: 'c.py', side: 'new' as const, line: 3 },
    ];
    useStore.setState({ jumps, jumpIndex: 1 });
    await render();
    const jumpForward = vi.fn();
    await act(() => useStore.setState({ jumpForward }));
    await act(() => forward().click());
    expect(jumpForward).toHaveBeenCalledOnce();
  });
});
