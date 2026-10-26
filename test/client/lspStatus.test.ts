// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LspLogEntry, LspServerStatus, LspStatus } from '@/shared/protocol.js';

const { state } = vi.hoisted(() => ({
  state: {
    snapshot: null,
    github: { status: 'idle' },
    lsp: { enabled: true, servers: [], missing: [] } as LspStatus,
    lspLogs: {} as Record<string, { seq: number; entries: LspLogEntry[] }>,
    watchLspLog: () => {},
    config: { lineWrap: true },
    layout: { treeVisible: true, panels: {} },
    theme: 'dark',
    diffStyle: 'split',
    jumps: [],
    jumpIndex: 0,
    fileView: null,
  },
}));
vi.mock('@/client/store.js', () => ({ useStore: (select: (s: typeof state) => unknown) => select(state) }));
vi.mock('@/client/header/ModePicker.js', () => ({ ModePicker: () => null }));
vi.mock('@/client/header/SettingsDialog.js', () => ({ SettingsDialog: () => null }));
vi.mock('@/client/clipboard.js', () => ({ copyText: vi.fn() }));
import { copyText } from '@/client/clipboard.js';
import { Header } from '@/client/header/Header.js';
import { defineDiffStub } from './views.js';

defineDiffStub();

function render(...statuses: Partial<LspServerStatus>[]) {
  state.lsp.servers = statuses.map((status, i) => ({
    name: `server${i}`,
    command: `server${i}`,
    languages: ['python'],
    joins: [],
    supports: [],
    state: 'ready',
    log: { seq: 0, errors: 0, warnings: 0 },
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
    [[{}, { log: { seq: 3, errors: 0, warnings: 0 } }], 'Language servers: logs'],
    [[{ log: { seq: 3, errors: 2, warnings: 1 } }, { activity: ['Indexing'] }], 'Language servers: busy'],
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

  it('shows reported work, notices, and the log instead of claiming readiness', () => {
    state.lspLogs = {
      server1: {
        seq: 2,
        entries: [
          { id: 1, time: 0, source: 'stderr', level: 'log', message: 'Missing build tool', count: 1 },
          { id: 2, time: 0, source: 'log', level: 'warning', message: 'languageId not found', count: 3 },
        ],
      },
    };
    try {
      const popup = render(
        { activity: ['Loading workspace: dependencies'] },
        { notice: { severity: 'error', message: 'Workspace loading failed' }, log: { seq: 2, errors: 1, warnings: 3 } },
        {},
      ).querySelector('section[aria-label="Language server status"]')!;
      const text = popup.textContent;
      expect(text).toContain('Loading workspace: dependencies');
      expect(text).toContain('Working');
      expect(text).toContain('Workspace loading failed');
      expect(text).toContain('Log (1 error, 3 warnings)');
      expect(text).toContain('Connected');
      const lines = [...popup.querySelectorAll('ol[aria-label="server log"] li')].map((li) => li.textContent);
      expect(lines).toEqual(['log stderr Missing build tool', 'warning log languageId not found ×3']);
    } finally {
      state.lspLogs = {};
    }
  });

  it('wraps log lines with the diff, and scrolls them sideways without', () => {
    state.lspLogs = {
      server0: { seq: 1, entries: [{ id: 1, time: 0, source: 'stderr', level: 'log', message: 'x', count: 1 }] },
    };
    try {
      const line = () =>
        render({ log: { seq: 1, errors: 0, warnings: 0 } }).querySelector('ol[aria-label="server log"] li')!;
      expect(line().className).toContain('whitespace-pre-wrap');
      state.config.lineWrap = false;
      expect(line().className).toBe('whitespace-pre');
      // The list itself scrolls, so an unwrapped line gets a horizontal bar there.
      expect(line().closest('ol')!.className).toContain('overflow-auto');
    } finally {
      state.lspLogs = {};
      state.config.lineWrap = true;
    }
  });

  it('names missing servers compactly with install candidates in the tooltip', () => {
    state.lsp.missing = [
      { language: 'rust', tried: ['rust-analyzer'] },
      { language: 'python', tried: [] },
      { language: 'vue', tried: ['vtsls'], why: 'vue-language-server is on PATH but its plugin is not' },
    ];
    try {
      const popup = render().querySelector('section')!;
      expect(popup.textContent).toContain('Not on PATH');
      expect(popup.textContent).toContain('Disabled');
      expect(popup.textContent).toContain('Incomplete');
      expect(popup.querySelector('[title="rust-analyzer"]')!.textContent).toContain('rust');
      expect(
        popup.querySelector('[title="vue-language-server is on PATH but its plugin is not"]')!.textContent,
      ).toContain('vue');
    } finally {
      state.lsp.missing = [];
    }
  });

  it.each([true, false])('reports clipboard success=%s and copies the full log', async (success) => {
    const long = 'long line '.repeat(200).trim();
    state.lspLogs = {
      server0: {
        seq: 1,
        entries: [
          { id: 1, time: 0, source: 'stderr', level: 'log', message: 'first line', count: 1 },
          { id: 2, time: 0, source: 'message', level: 'error', message: long, count: 2 },
        ],
      },
    };
    render({ log: { seq: 1, errors: 1, warnings: 0 } });
    vi.mocked(copyText).mockResolvedValue(success);
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(Header)));
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Copy log"]')!.click());
      expect(copyText).toHaveBeenLastCalledWith(`log     stderr  first line\nerror   message ${long} ×2`);
      expect(container.textContent).toContain(success ? 'Copied' : 'Copy failed. Select the log');
      expect(container.querySelectorAll('ol[aria-label="server log"] li')).toHaveLength(2);
    } finally {
      await act(async () => root.unmount());
      state.lspLogs = {};
    }
  });
});
