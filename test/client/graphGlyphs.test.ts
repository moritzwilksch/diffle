import { describe, expect, it } from 'vitest';
import { STATUS, kindGlyph } from '@/client/connected/graph/glyphs.js';
import { KIND_LABEL } from '@/client/lsp/symbolKind.js';
import type { NodeStatus } from '@/client/connected/graph/model.js';

const STATUSES: NodeStatus[] = ['added', 'modified', 'deleted', 'renamed', 'context'];
const TOKENS = [
  'text-add',
  'text-accent',
  'text-del',
  'text-kind-type',
  'text-kind-callable',
  'text-kind-value',
  'text-muted',
];

describe('STATUS', () => {
  it('names each status with its words and a theme colour', () => {
    expect(STATUSES.map((s) => [STATUS[s].label, STATUS[s].text])).toEqual([
      ['Added', 'text-add'],
      ['Modified', 'text-accent'],
      ['Deleted', 'text-del'],
      ['Renamed', 'text-kind-type'],
      ['Unchanged caller', 'text-muted'],
    ]);
  });

  it('gives each status its own icon', () => {
    const icons = STATUSES.map((s) => STATUS[s].Icon);
    expect(icons.every(Boolean)).toBe(true);
    expect(new Set(icons).size).toBe(STATUSES.length);
  });
});

describe('kindGlyph', () => {
  const kinds = Object.keys(KIND_LABEL).map(Number);

  it('covers every SymbolKind the client labels, with that label and a token colour', () => {
    expect(kinds.length).toBe(26);
    for (const k of kinds) {
      const g = kindGlyph(k);
      expect(g.label).toBe(KIND_LABEL[k]);
      expect(g.Icon).toBeTruthy();
      expect(TOKENS).toContain(g.text);
    }
  });

  it('colours types, callables and values by their group', () => {
    expect(kindGlyph(5).text).toBe('text-kind-type');
    expect(kindGlyph(12).text).toBe('text-kind-callable');
    expect(kindGlyph(13).text).toBe('text-kind-value');
    expect(kindGlyph(2).text).toBe('text-muted');
  });

  it('falls back to a generic Symbol for an unknown kind', () => {
    for (const k of [0, 27, 999, -1]) {
      const g = kindGlyph(k);
      expect(g.label).toBe('Symbol');
      expect(g.Icon).toBeTruthy();
      expect(TOKENS).toContain(g.text);
    }
    expect(kindGlyph(999).Icon).not.toBe(kindGlyph(5).Icon);
  });
});
