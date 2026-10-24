// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/client/api.js', () => ({ api: {} }));

const { COLUMNS } = await import('@/client/keyboard/HelpOverlay.js');

describe('HelpOverlay', () => {
  it('lists every shortcut once across two columns of titled sections', () => {
    expect(COLUMNS).toHaveLength(2);
    const keys = COLUMNS.flat().flatMap((s) => s.rows.map(([k]) => k));
    expect(new Set(keys).size).toBe(keys.length);
    for (const section of COLUMNS.flat()) {
      expect(section.title).not.toBe('');
      expect(section.rows.length).toBeGreaterThan(0);
    }
  });

  // Rows never wrap, so a long description would widen the dialog past the viewport.
  it('keeps every description short enough for one line', () => {
    for (const [, action] of COLUMNS.flat().flatMap((s) => s.rows)) expect(action.length).toBeLessThanOrEqual(60);
  });

  it('lists the graph key under the Connected scope', () => {
    const connected = COLUMNS.flat().find((s) => s.title === 'Connected scope');
    expect(connected?.rows.map(([k]) => k)).toContain('gm');
  });
});
