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
  },
}));
vi.mock('../../src/client/store.js', () => ({ useStore: (select: (s: typeof state) => unknown) => select(state) }));
vi.mock('../../src/client/header/ModePicker.js', () => ({ ModePicker: () => null }));
vi.mock('../../src/client/header/SettingsDialog.js', () => ({ SettingsDialog: () => null }));
vi.mock('../../src/client/clipboard.js', () => ({ copyText: vi.fn() }));
import { copyText } from '../../src/client/clipboard.js';
import { Header } from '../../src/client/header/Header.js';

function render(status: Partial<LspServerStatus>) {
  state.lsp.servers = [{ name: 'server', command: 'server', languages: ['python'], state: 'ready', ...status }];
  return renderToStaticMarkup(createElement(Header));
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
  it('shows reported work instead of claiming workspace readiness', () => {
    const html = render({ activity: ['Loading workspace: dependencies'] });
    expect(html).toContain('Loading workspace: dependencies');
    expect(html).toContain('>busy</summary>');
    expect(render({})).toContain('Connected');
    expect(html).toContain('<details');
    expect(html).toContain('aria-label="Language server status"');
  });

  it('spins during initialization and standard reported work', () => {
    expect(render({ state: 'starting' })).toContain('animate-spin');
    expect(render({ activity: ['Loading workspace'] })).toContain('animate-spin');
    expect(render({})).not.toContain('animate-spin');
    expect(render({})).toContain('lucide-check');
    expect(render({})).toContain('>Connected</span>');
    expect(render({})).toContain('>Details</summary>');
  });

  it('uses compact missing-server labels with install candidates in the tooltip', () => {
    state.lsp.missing = [
      { language: 'rust', tried: ['rust-analyzer'] },
      { language: 'python', tried: [] },
    ];
    try {
      const html = render({});
      expect(html).not.toContain('lucide-circle-off');
      expect(html.match(/lucide-x shrink-0/g)).toHaveLength(2);
      expect(html).toContain('>Not on PATH</span>');
      expect(html).toContain('>Disabled</span>');
      expect(html).toContain('title="rust-analyzer"');
      expect(html).not.toContain('nothing on PATH, tried');
    } finally {
      state.lsp.missing = [];
    }
  });

  it('keeps protocol errors and stderr visible while the process is alive', () => {
    const html = render({
      notice: { severity: 'error', message: 'Workspace loading failed' },
      stderr: 'Missing build tool',
    });
    expect(html).toContain('Workspace loading failed');
    expect(html).toContain('lucide-circle-alert');
    expect(html).toContain('Missing build tool');
    expect(html).toContain('>error</summary>');
    const stderrOnly = render({ stderr: 'Workspace configuration could not be read' });
    expect(stderrOnly).toContain('Workspace configuration could not be read');
    expect(stderrOnly).toContain('>logs</summary>');
  });

  it('bounds an unwrapped stderr code block with scrolling on both axes', () => {
    const container = document.createElement('div');
    container.innerHTML = render({ stderr: 'long log\nsecond line' });
    const log = container.querySelector('pre[aria-label="stderr log"]')!;
    expect(log.textContent).toBe('long log\nsecond line');
    expect(log.classList.contains('max-h-[min(12rem,25vh)]')).toBe(true);
    expect(log.classList.contains('overflow-auto')).toBe(true);
    expect(log.classList.contains('whitespace-pre')).toBe(true);
    expect(log.parentElement!.classList.contains('bg-canvas')).toBe(false);
    expect(log.parentElement!.classList.contains('border')).toBe(false);
    expect(log.getAttribute('tabindex')).toBe('0');
    expect(render({})).not.toContain('Copy stderr');
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
