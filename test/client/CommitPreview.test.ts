// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LastCommitsPreview } from '../../src/shared/protocol.js';

vi.mock('../../src/client/api.js', () => ({ api: { lastCommitsPreview: vi.fn() } }));
const { api } = await import('../../src/client/api.js');
const { CommitPreview } = await import('../../src/client/header/CommitPreview.js');
let root: Root;
let host: HTMLDivElement;
const requests: { signal?: AbortSignal; resolve: (result: LastCommitsPreview) => void }[] = [];
const commit = (message: string) => ({ sha: 'abcdef123', short: 'abcdef1', message });
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  requests.length = 0;
  vi.mocked(api.lastCommitsPreview)
    .mockReset()
    .mockImplementation((_count, signal) => new Promise((resolve) => requests.push({ signal, resolve })));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});
async function render(count: number | null) {
  await act(() => root.render(createElement(CommitPreview, { count, version: 1 })));
  await act(() => vi.advanceTimersByTime(150));
}
it('shows endpoint messages and ignores responses for older counts', async () => {
  await render(1);
  await render(2);
  expect(requests[0]!.signal?.aborted).toBe(true);
  await act(() => requests[1]!.resolve({ old: commit('Older commit\n\nDetails'), head: commit('Latest commit') }));
  expect(host.textContent).toContain('HEAD~2');
  expect(host.textContent).toContain('Older commit\n\nDetails');
  expect(host.textContent).toContain('Latest commit');
  await act(() => requests[0]!.resolve({ old: commit('Stale message'), head: commit('Stale head') }));
  expect(host.textContent).not.toContain('Stale');
});
it('handles missing history and clears previews for invalid input', async () => {
  await render(999);
  await act(() => requests[0]!.resolve({ old: null, head: commit('Latest commit') }));
  expect(host.textContent).toContain('Not enough history');
  expect(host.textContent).toContain('Latest commit');
  await render(null);
  expect(host.textContent).toContain('Enter a positive whole number');
  expect(host.textContent).not.toContain('Latest commit');
  expect(api.lastCommitsPreview).toHaveBeenCalledTimes(1);
});

it('preserves the measured preview height through loading and empty input', async () => {
  let measuredHeight = 88;
  const measure = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(() => ({ height: measuredHeight }) as DOMRect);
  try {
    await render(1);
    measuredHeight = 180;
    await act(() => requests[0]!.resolve({ old: commit('Long message'), head: commit('Latest commit') }));
    const area = host.querySelector<HTMLElement>('.commit-preview-area')!;
    expect(area.style.minHeight).toBe('180px');
    measuredHeight = 24;
    await render(2);
    expect(area.getAttribute('aria-busy')).toBe('true');
    expect(area.style.minHeight).toBe('180px');
    await render(null);
    expect(area.style.minHeight).toBe('180px');
  } finally {
    measure.mockRestore();
  }
});
