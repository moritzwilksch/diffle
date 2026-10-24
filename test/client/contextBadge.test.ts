import { describe, expect, it } from 'vitest';
import type { GraphContext } from '@/shared/protocol.js';
import { contextTitle, usesLabel } from '@/client/connected/clusters/ContextBadge.js';

const entry = (uses: GraphContext['uses'], refs = 0): GraphContext => ({ path: 'ctx/x.ts', refs, uses });

describe('usesLabel', () => {
  it('names each symbol with how often it is used, then the first lines', () => {
    expect(
      usesLabel([
        { symbol: 'foo', kind: 12, path: 'src/lib.ts', lines: [42, 51, 88] },
        { symbol: 'bar', kind: 12, path: 'src/lib.ts', lines: [60] },
      ]),
    ).toBe('foo ×3, bar ×1 · L42, L51, L60');
  });

  it('orders the lines ascending across symbols and shows only the first few', () => {
    expect(
      usesLabel([
        { symbol: 'foo', kind: 12, path: 'src/lib.ts', lines: [90, 10] },
        { symbol: 'bar', kind: 12, path: 'src/lib.ts', lines: [20, 30, 40] },
      ]),
    ).toBe('foo ×2, bar ×3 · L10, L20, L30');
  });

  it('folds symbols past the third into a count', () => {
    const uses = ['a', 'b', 'c', 'd', 'e'].map((symbol, i) => ({
      symbol,
      kind: 12,
      path: 'src/lib.ts',
      lines: [i + 1],
    }));
    expect(usesLabel(uses)).toBe('a ×1, b ×1, c ×1, +2 more · L1, L2, L3');
  });

  it('leaves out what the graph does not say', () => {
    expect(usesLabel([])).toBe('');
    expect(usesLabel([{ symbol: 'foo', kind: 12, path: 'src/lib.ts', lines: [] }])).toBe('foo');
  });
});

describe('contextTitle', () => {
  it('says why the file is listed, with the reference count', () => {
    expect(contextTitle(entry([{ symbol: 'foo', kind: 12, path: 'src/lib.ts', lines: [4] }], 1))).toBe(
      'Not changed. Uses 1 changed symbol of this cluster: foo (1 reference)',
    );
    expect(
      contextTitle(
        entry(
          [
            { symbol: 'foo', kind: 12, path: 'src/lib.ts', lines: [4, 9] },
            { symbol: 'bar', kind: 12, path: 'src/lib.ts', lines: [1] },
          ],
          3,
        ),
      ),
    ).toBe('Not changed. Uses 2 changed symbols of this cluster: foo, bar (3 references)');
  });
});
