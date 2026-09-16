// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import pkg from '../../package.json' with { type: 'json' };
import { DEFAULT_USER_CONFIG } from '../../src/shared/protocol.js';

const { state } = vi.hoisted(() => ({ state: { config: null as unknown, saveConfig: vi.fn() } }));
vi.mock('../../src/client/store.js', () => ({ useStore: (select: (s: typeof state) => unknown) => select(state) }));
import { SettingsDialog } from '../../src/client/header/SettingsDialog.js';

describe('SettingsDialog', () => {
  it('shows the installed diffle version', () => {
    state.config = DEFAULT_USER_CONFIG;
    const html = renderToStaticMarkup(createElement(SettingsDialog, { onClose: () => {} }));
    expect(html).toContain(`diffle v${pkg.version}`);
  });
});
