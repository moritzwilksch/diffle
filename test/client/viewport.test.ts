import { describe, expect, it } from 'vitest';
import { startDiffStyle, startLayout, windowWidth } from '@/client/viewport.js';

const saved = {
  treeWidth: 300,
  treeVisible: true,
  panels: { diff: { width: 400, visible: true }, graph: { width: null, visible: false } },
};

describe('windowWidth', () => {
  it('reads a window beside an editor as narrow and a full screen as wide', () => {
    expect(windowWidth(1280, 1440)).toBe('narrow');
    expect(windowWidth(1100, 1000)).toBe('narrow');
    expect(windowWidth(1440, 900)).toBe('wide');
  });
});

describe('startDiffStyle', () => {
  it('forces the style of a given viewport over the saved one', () => {
    expect(startDiffStyle('narrow', 'split')).toBe('unified');
    expect(startDiffStyle('wide', 'unified')).toBe('split');
  });

  it('keeps the saved style on auto', () => {
    expect(startDiffStyle('auto', 'unified')).toBe('unified');
  });
});

describe('startLayout', () => {
  it('collapses the tree and every side panel when narrow, keeping their widths', () => {
    expect(startLayout('narrow', saved)).toEqual({
      treeWidth: 300,
      treeVisible: false,
      panels: {
        diff: { width: 400, visible: false },
        graph: { width: null, visible: false },
        tour: { width: null, visible: false },
      },
    });
  });

  it('shows the tree and every side panel when wide', () => {
    const layout = startLayout('wide', { ...saved, treeVisible: false });
    expect(layout.treeVisible).toBe(true);
    expect(Object.values(layout.panels).map((p) => p.visible)).toEqual([true, true, true]);
  });

  it('keeps the saved layout on auto', () => {
    expect(startLayout('auto', saved)).toEqual(saved);
  });
});
