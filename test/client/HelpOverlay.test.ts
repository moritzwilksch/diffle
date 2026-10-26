// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/client/api.js', () => ({ api: {} }));

const { DIFF_HELP } = await import('@/client/keyboard/HelpOverlay.js');
const { GRAPH_HELP } = await import('@/client/graph/help.js');
const VIEWS = { diff: DIFF_HELP, graph: GRAPH_HELP };

describe('HelpOverlay', () => {
  it.each(Object.entries(VIEWS))('lists every %s shortcut once across two columns of titled sections', (_, columns) => {
    expect(columns).toHaveLength(2);
    const keys = columns.flat().flatMap((s) => s.rows.map(([k]) => k));
    expect(new Set(keys).size).toBe(keys.length);
    for (const section of columns.flat()) {
      expect(section.title).not.toBe('');
      expect(section.rows.length).toBeGreaterThan(0);
    }
  });

  // Rows never wrap, so a long description would widen the dialog past the viewport.
  it('keeps every description short enough for one line', () => {
    for (const [, action] of Object.values(VIEWS).flatMap((c) => c.flat().flatMap((s) => s.rows)))
      expect(action.length).toBeLessThanOrEqual(60);
  });
});
