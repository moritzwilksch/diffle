// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LspServerStatus, LspStatus } from '../../src/shared/protocol.js';

const { state } = vi.hoisted(() => ({
  state: {
    snapshot: null,
    github: { status: 'idle' },
    lsp: { enabled: true, servers: [], missing: [] } as LspStatus,
    layout: { treeVisible: true, panelVisible: true },
    theme: 'dark',
    diffStyle: 'split',
    jumps: [],
    jumpIndex: 0,
    fileView: null,
  },
}));
vi.mock('../../src/client/store.js', () => ({ useStore: (select: (s: typeof state) => unknown) => select(state) }));
vi.mock('../../src/client/header/ModePicker.js', () => ({ ModePicker: () => null }));
vi.mock('../../src/client/header/SettingsDialog.js', () => ({ SettingsDialog: () => null }));
vi.mock('../../src/client/clipboard.js', () => ({ copyText: vi.fn() }));
import { copyText } from '../../src/client/clipboard.js';
import { Header } from '../../src/client/header/Header.js';

function render(...statuses: Partial<LspServerStatus>[]) {
  state.lsp.servers = statuses.map((status, i) => ({
    name: `server${i}`,
    command: `server${i}`,
    languages: ['python'],
    state: 'ready',
    ...status,
  }));
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(createElement(Header));
  return container;
}

describe('LSP status indicator', () => {
  it('dismisses on outside click, Escape, and the close button', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(Header)));
      const popup = container.querySelector('details')!;
      const summary = popup.querySelector('summary')!;
      popup.open = true;
      popup.querySelector('section')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      expect(popup.open).toBe(true);
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      expect(popup.open).toBe(false);

      popup.open = true;
      const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      document.dispatchEvent(escape);
      expect(popup.open).toBe(false);
      expect(escape.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(summary);

      popup.open = true;
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="Close language server status"]')!.click(),
      );
      expect(popup.open).toBe(false);
      expect(document.activeElement).toBe(summary);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
  // Header's summary names the most severe state across all servers.
  it.each<[Partial<LspServerStatus>[], string]>([
    [[{}], 'Language servers'],
    [[{}, { stderr: 'log' }], 'Language servers: logs'],
    [[{ stderr: 'log' }, { activity: ['Indexing'] }], 'Language servers: busy'],
    [[{ activity: ['Indexing'] }, { state: 'starting' }], 'Language servers: starting'],
    [[{ state: 'starting' }, { notice: { severity: 'warning', message: 'w' } }], 'Language servers: warning'],
    [
      [{ notice: { severity: 'warning', message: 'w' } }, { notice: { severity: 'error', message: 'e' } }],
      'Language servers: error',
    ],
    [[{ notice: { severity: 'error', message: 'e' } }, { state: 'unavailable' }], 'Language servers: unavailable'],
  ])('labels %j as %s', (servers, label) => {
    expect(
      render(...servers)
        .querySelector('summary')!
        .getAttribute('aria-label'),
    ).toBe(label);
  });

  it('shows reported work, notices, and stderr instead of claiming readiness', () => {
    const popup = render(
      { activity: ['Loading workspace: dependencies'] },
      { notice: { severity: 'error', message: 'Workspace loading failed' }, stderr: 'Missing build tool' },
      {},
    ).querySelector('section[aria-label="Language server status"]')!.textContent;
    expect(popup).toContain('Loading workspace: dependencies');
    expect(popup).toContain('Working');
    expect(popup).toContain('Workspace loading failed');
    expect(popup).toContain('Missing build tool');
    expect(popup).toContain('Connected');
  });

  it('names missing servers compactly with install candidates in the tooltip', () => {
    state.lsp.missing = [
      { language: 'rust', tried: ['rust-analyzer'] },
      { language: 'python', tried: [] },
    ];
    try {
      const popup = render().querySelector('section')!;
      expect(popup.textContent).toContain('Not on PATH');
      expect(popup.textContent).toContain('Disabled');
      expect(popup.querySelector('[title="rust-analyzer"]')!.textContent).toContain('rust');
    } finally {
      state.lsp.missing = [];
    }
  });

  it.each([true, false])('reports clipboard success=%s and copies the full log', async (success) => {
    const text = 'first line\n' + 'long line '.repeat(200);
    render({ stderr: text });
    vi.mocked(copyText).mockResolvedValue(success);
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(Header)));
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Copy stderr"]')!.click());
      expect(copyText).toHaveBeenLastCalledWith(text);
      expect(container.textContent).toContain(success ? 'Copied' : 'Copy failed. Select the log');
      expect(container.querySelector('pre[aria-label="stderr log"]')!.textContent).toBe(text);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
