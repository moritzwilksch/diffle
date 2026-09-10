import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LspServerStatus, LspStatus } from '../../src/shared/protocol.js';

const { state } = vi.hoisted(() => ({
  state: {
    snapshot: null,
    lsp: { enabled: true, servers: [], missing: [] } as LspStatus,
    layout: { treeVisible: true, panelVisible: true },
    theme: 'dark',
    diffStyle: 'split',
  },
}));
vi.mock('../../src/client/store.js', () => ({ useStore: (select: (s: typeof state) => unknown) => select(state) }));
vi.mock('../../src/client/header/ModePicker.js', () => ({ ModePicker: () => null }));
vi.mock('../../src/client/header/SettingsDialog.js', () => ({ SettingsDialog: () => null }));
import { Header } from '../../src/client/header/Header.js';

function render(status: Partial<LspServerStatus>) {
  state.lsp.servers = [{ name: 'server', command: 'server', languages: ['python'], state: 'ready', ...status }];
  return renderToStaticMarkup(createElement(Header));
}

describe('LSP status indicator', () => {
  it('shows reported work instead of claiming workspace readiness', () => {
    const html = render({ activity: ['Loading workspace: dependencies'] });
    expect(html).toContain('Loading workspace: dependencies');
    expect(html).toContain('>busy</span>');
    expect(render({})).toContain('server (python): connected');
  });

  it('keeps protocol errors and stderr visible while the process is alive', () => {
    const html = render({
      notice: { severity: 'error', message: 'Workspace loading failed' },
      stderr: 'Missing build tool',
    });
    expect(html).toContain('Workspace loading failed');
    expect(html).toContain('Missing build tool');
    expect(html).toContain('>error</span>');
    const stderrOnly = render({ stderr: 'Workspace configuration could not be read' });
    expect(stderrOnly).toContain('Workspace configuration could not be read');
    expect(stderrOnly).toContain('>logs</span>');
  });
});
