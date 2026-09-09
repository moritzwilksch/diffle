// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/client/api.js', () => ({ api: {} }));

const { useStore } = await import('../../src/client/store.js');
const { COLUMNS, HelpOverlay } = await import('../../src/client/keyboard/HelpOverlay.js');

// Every binding the keymap exposes; regrouping the overlay must not drop one.
const BOUND = [
  'j / k  or  ↓ / ↑', '←  or  ⌘/Ctrl+Shift+e  /  →', 'Ctrl+d / Ctrl+u', 'Ctrl+o / Ctrl+i', 'J / K', '] / [   n / N', 'gg / G', '{n}gg / {n}G', 'V, then j / k',
  'c', 'e', 'dd', 'R', 'v', 'zo / zc', 'zO / zC', 'zt / zb', 'zz', 'F', 's', 't', 'yy or Y / yf', '/', 'g/', 'gf', 'w / b', '0 / $', '* / #',
  'hover a symbol  or  gh', 'click a symbol', 'gd  or  ⌘/Ctrl+click', 'gy', 'gA', 'gs / gS', 'm, then 1–5', '⌘/Ctrl+b', '?', 'Esc',
];

describe('HelpOverlay', () => {
  it('lists every shortcut exactly once across two columns of titled sections', () => {
    expect(COLUMNS).toHaveLength(2);
    const keys = COLUMNS.flat().flatMap((s) => s.rows.map(([k]) => k));
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual([...BOUND].sort());
    for (const section of COLUMNS.flat()) {
      expect(section.title).not.toBe('');
      expect(section.rows.length).toBeGreaterThan(0);
    }
  });

  // Rows never wrap, so a long description would widen the dialog past the viewport.
  it('keeps every description short enough for one line', () => {
    for (const [, action] of COLUMNS.flat().flatMap((s) => s.rows)) expect(action.length).toBeLessThanOrEqual(60);
  });

  describe('rendering', () => {
    let root: Root;
    let host: HTMLDivElement;
    beforeEach(() => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      useStore.setState({ helpOpen: true });
      host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
    });
    afterEach(async () => {
      await act(() => root.unmount());
      host.remove();
    });

    it('renders one column per group and a heading per section', async () => {
      await act(() => root.render(createElement(HelpOverlay)));
      expect(host.querySelectorAll('.help-col')).toHaveLength(2);
      const headings = [...host.querySelectorAll('.help-body h4')].map((h) => h.textContent);
      expect(headings).toEqual(COLUMNS.flat().map((s) => s.title));
      expect(host.querySelectorAll('.help-row')).toHaveLength(BOUND.length);
    });
  });
});
