import { describe, expect, it } from 'vitest';
import type { GraphCluster, GraphResponse } from '@/shared/protocol.js';
import { clusterRows, scopePaths } from '@/client/connected/clusters/rows.js';

const cluster = (id: string, files: string[], extra: Partial<GraphCluster> = {}): GraphCluster => ({
  id,
  label: 'src',
  files,
  symbols: 1,
  context: [],
  contextTotal: 0,
  links: [],
  linksTotal: 0,
  ...extra,
});
const graph = (g: Partial<GraphResponse> = {}): GraphResponse => ({
  version: 1,
  clusters: [],
  unlinked: [],
  other: [],
  ...g,
});

describe('clusterRows', () => {
  it('lists the clusters in server order, then Unlinked, then Other, with counts and 1-based indexes', () => {
    const rows = clusterRows(
      graph({
        clusters: [cluster('a.ts', ['a.ts', 'b.ts', 'c.ts'], { label: 'src/a' }), cluster('d.ts', ['d.ts', 'e.ts'])],
        unlinked: ['f.ts'],
        other: ['README.md', 'logo.png'],
      }),
      null,
    );
    expect(rows.map((r) => [r.index, r.label, r.folder, r.count, r.context])).toEqual([
      [1, 'a.ts', 'src/a', 3, 0],
      [2, 'd.ts', 'src', 2, 0],
      [null, 'Unlinked (1)', null, null, 0],
      [null, 'Other (2)', null, null, 0],
    ]);
    expect(rows.map((r) => r.focus)).toEqual([
      { kind: 'cluster', id: 'a.ts' },
      { kind: 'cluster', id: 'd.ts' },
      { kind: 'unlinked' },
      { kind: 'other' },
    ]);
  });

  it('shows "(root)" as the folder of a cluster whose members share no directory', () => {
    const [row] = clusterRows(graph({ clusters: [cluster('a.ts', ['a.ts', 'b/c.ts'], { label: '' })] }), null);
    expect(row?.label).toBe('a.ts');
    expect(row?.folder).toBe('(root)');
  });

  it('names a cluster by its title, and keeps the folder apart unless the folder is the title', () => {
    const [row] = clusterRows(
      graph({
        clusters: [
          cluster('crates/x/facts.rs', ['crates/x/facts.rs', 'crates/x/mod.rs'], {
            label: 'crates/x',
            links: [{ from: 'crates/x/mod.rs', to: 'crates/x/facts.rs', weight: 2, uses: [], total: 2 }],
          }),
        ],
      }),
      null,
    );
    expect([row?.label, row?.folder]).toEqual(['facts.rs', 'crates/x']);
    const [tests] = clusterRows(
      graph({ clusters: [cluster('t/a.test.ts', ['t/a.test.ts', 't/b.test.ts'], { label: 't' })] }),
      null,
    );
    expect([tests?.label, tests?.folder]).toEqual(['t', null]);
  });

  it('carries the unchanged-caller total as context, and 0 when there is none', () => {
    const rows = clusterRows(
      graph({ clusters: [cluster('a.ts', ['a.ts'], { contextTotal: 23 }), cluster('b.ts', ['b.ts'])] }),
      null,
    );
    expect(rows.map((r) => r.context)).toEqual([23, 0]);
  });

  it('leaves out empty groups and numbers the clusters that remain', () => {
    const rows = clusterRows(
      graph({ clusters: [cluster('a.ts', []), cluster('b.ts', ['b.ts']), cluster('c.ts', ['c.ts'])] }),
      null,
    );
    expect(rows.map((r) => [r.index, r.focus])).toEqual([
      [1, { kind: 'cluster', id: 'b.ts' }],
      [2, { kind: 'cluster', id: 'c.ts' }],
    ]);
    expect(clusterRows(graph(), null)).toEqual([]);
  });

  it('flags only the focused group', () => {
    const g = graph({ clusters: [cluster('a.ts', ['a.ts']), cluster('b.ts', ['b.ts'])], unlinked: ['u.ts'] });
    expect(clusterRows(g, { kind: 'cluster', id: 'b.ts' }).map((r) => r.focused)).toEqual([false, true, false]);
    expect(clusterRows(g, { kind: 'unlinked' }).map((r) => r.focused)).toEqual([false, false, true]);
    expect(clusterRows(g, null).some((r) => r.focused)).toBe(false);
  });
});

describe('cluster row text', () => {
  const g = graph({
    clusters: [
      cluster('src/client/store.ts', ['src/client/store.ts', 'src/client/model.ts', 'src/client/api.ts'], {
        label: 'src/client',
        symbols: 12,
        contextTotal: 4,
        context: [{ path: 'ctx/a.ts', refs: 2, uses: [] }],
      }),
      cluster('solo.ts', ['solo.ts'], { label: '' }),
    ],
    unlinked: ['u.ts'],
    other: ['README.md', 'logo.png'],
  });
  const rows = clusterRows(g, null);

  it('names a cluster by its smallest source file when no arrow settles it, and a bucket by its size', () => {
    expect(rows.map((r) => r.label)).toEqual(['api.ts', 'solo.ts', 'Unlinked (1)', 'Other (2)']);
  });

  it('reads a cluster row to a screen reader as title, folder, changed files and unchanged callers', () => {
    expect(rows[0]!.ariaLabel).toBe('api.ts, in src/client, 3 changed files, 4 unchanged callers');
    expect(rows[1]!.ariaLabel).toBe('solo.ts, in (root), 1 changed file, 0 unchanged callers');
  });

  it('puts the full detail in a cluster’s hover title: title, folder, sizes, and its first members', () => {
    expect(rows[0]!.title).toBe(
      'api.ts\nsrc/client\n3 changed files · 12 symbols · 4 unchanged callers\nsrc/client/store.ts\nsrc/client/model.ts\nsrc/client/api.ts',
    );
  });

  it('folds the members past the first few into a count', () => {
    const many = Array.from({ length: 9 }, (_, i) => `m${i}.ts`);
    const [row] = clusterRows(graph({ clusters: [cluster('m0.ts', many, { label: 'x' })] }), null);
    expect(row!.title.split('\n').slice(3)).toEqual(['m0.ts', 'm1.ts', 'm2.ts', 'm3.ts', 'm4.ts', '+4 more']);
  });

  it('explains Unlinked and Other in their title and in the hint shown when focused', () => {
    expect(rows[2]!.hint).toBe('Unlinked: code files no other changed file references.');
    expect(rows[3]!.hint).toBe('Other: files no language server could graph (no server, binary, deleted, generated).');
    expect(rows[2]!.title).toBe(rows[2]!.hint);
    expect(rows[3]!.title).toBe(rows[3]!.hint);
    expect(rows[3]!.ariaLabel).toBe('Other (2)');
    expect(rows[0]!.hint).toBeNull();
  });

  it('counts the callers the server listed apart from the uncapped total', () => {
    expect(rows.map((r) => [r.context, r.listed])).toEqual([
      [4, 1],
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
  });
});

describe('scopePaths', () => {
  const changed = ['a.ts', 'b.ts', 'z.md'];
  const tree = ['a.ts', 'b.ts', 'c.ts', 'z.md'];
  const g = graph({
    clusters: [
      cluster('a.ts', ['a.ts', 'b.ts'], {
        context: [{ path: 'c.ts', uses: [], refs: 2 }],
        contextTotal: 1,
      }),
    ],
    other: ['z.md'],
  });
  const base = { changed, tree, graph: g, focus: { kind: 'cluster', id: 'a.ts' } as const, context: false };

  it('lists the changed files in Changed and the whole tree in All files', () => {
    expect(scopePaths({ ...base, scope: 'changed' })).toEqual(changed);
    expect(scopePaths({ ...base, scope: 'all' })).toEqual(tree);
  });

  it('narrows Connected to the focused group, with its callers only when context is on', () => {
    expect(scopePaths({ ...base, scope: 'connected' })).toEqual(['a.ts', 'b.ts']);
    expect(scopePaths({ ...base, scope: 'connected', context: true })).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(scopePaths({ ...base, scope: 'connected', focus: { kind: 'other' }, context: true })).toEqual(['z.md']);
  });

  it('never lists a caller twice when an older graph still names a file that is changed now', () => {
    const stale = { ...base, changed: [...changed, 'c.ts'], scope: 'connected' as const, context: true };
    expect(scopePaths(stale)).toEqual(['a.ts', 'b.ts']);
  });

  it('lists a file as caller exactly when the pane would, whatever the graph version', () => {
    const olderGraph = { ...g, version: 0 };
    expect(scopePaths({ ...base, graph: olderGraph, scope: 'connected', context: true })).toEqual([
      'a.ts',
      'b.ts',
      'c.ts',
    ]);
  });

  it('lists every changed file in Connected while the graph is absent', () => {
    expect(scopePaths({ ...base, scope: 'connected', graph: null, focus: null, context: true })).toEqual(changed);
  });
});
