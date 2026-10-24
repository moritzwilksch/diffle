import { describe, expect, it } from 'vitest';
import type { GraphCluster, GraphResponse } from '@/shared/protocol.js';
import {
  callers,
  canListContext,
  clusterAt,
  contextOf,
  focusGroups,
  groupOf,
  keptFocus,
  linkLines,
  listing,
  moveFocus,
  type Focus,
} from '@/client/connected/clusters/focus.js';

const cluster = (id: string, files: string[], context: string[] = []): GraphCluster => ({
  id,
  label: '',
  files,
  symbols: files.length,
  context: context.map((path) => ({ path, uses: [], refs: 1 })),
  contextTotal: context.length,
  links: [],
  linksTotal: 0,
});

const graph = (over: Partial<GraphResponse> = {}): GraphResponse => ({
  version: 1,
  clusters: [
    cluster('a/one.ts', ['a/one.ts', 'a/two.ts'], ['ctx/x.ts', 'ctx/y.ts']),
    cluster('b/one.ts', ['b/one.ts']),
  ],
  unlinked: ['z/solo.ts'],
  other: ['README.md', 'docs/guide.md'],
  ...over,
});

/** Every changed file, in the tree order the model hands over. */
const CHANGED = ['README.md', 'a/one.ts', 'a/two.ts', 'b/one.ts', 'docs/guide.md', 'z/solo.ts'];

const cl = (id: string): Focus => ({ kind: 'cluster', id });
const UNLINKED: Focus = { kind: 'unlinked' };
const OTHER: Focus = { kind: 'other' };

describe('listing', () => {
  it('lists every changed file when nothing is focused', () => {
    expect(listing(CHANGED, graph(), null)).toEqual(CHANGED);
    expect(listing(CHANGED, null, null)).toEqual(CHANGED);
  });

  it('lists a cluster in the order of `changed`, whatever order the server named its files in', () => {
    const g = graph({ clusters: [cluster('a/one.ts', ['a/two.ts', 'a/one.ts'])] });
    expect(listing(CHANGED, g, cl('a/one.ts'))).toEqual(['a/one.ts', 'a/two.ts']);
  });

  it('lists the unlinked and the other group, in tree order', () => {
    expect(listing(CHANGED, graph(), UNLINKED)).toEqual(['z/solo.ts']);
    expect(listing(CHANGED, graph(), OTHER)).toEqual(['README.md', 'docs/guide.md']);
  });

  it('drops members that are no longer changed', () => {
    const changed = ['a/one.ts', 'b/one.ts'];
    expect(listing(changed, graph(), cl('a/one.ts'))).toEqual(['a/one.ts']);
  });

  it('lists everything when none of the group is changed any more, so a stale graph never empties the review', () => {
    const changed = ['b/one.ts', 'z/solo.ts'];
    expect(listing(changed, graph(), cl('a/one.ts'))).toEqual(changed);
    expect(listing(changed, graph(), OTHER)).toEqual(changed);
    expect(listing([], graph(), cl('a/one.ts'))).toEqual([]);
  });

  it('treats a focus the graph does not know like no focus', () => {
    expect(listing(CHANGED, graph(), cl('gone.ts'))).toEqual(CHANGED);
    expect(listing(CHANGED, null, cl('a/one.ts'))).toEqual(CHANGED);
    expect(listing(CHANGED, null, UNLINKED)).toEqual(CHANGED);
  });
});

describe('callers', () => {
  const changed = new Set(CHANGED);

  it('carries the focused cluster’s callers in rank order, and no other group’s', () => {
    expect(callers(changed, graph(), cl('a/one.ts'), true).map((c) => c.path)).toEqual(['ctx/x.ts', 'ctx/y.ts']);
    expect(callers(changed, graph(), cl('b/one.ts'), true)).toEqual([]);
    expect(callers(changed, graph(), UNLINKED, true)).toEqual([]);
  });

  it('lists none while context is off, without a graph, or without a focus', () => {
    expect(callers(changed, graph(), cl('a/one.ts'), false)).toEqual([]);
    expect(callers(changed, null, cl('a/one.ts'), true)).toEqual([]);
    expect(callers(changed, graph(), null, true)).toEqual([]);
  });

  it('never lists a file that is changed now, whatever an older graph says', () => {
    const g = graph({ clusters: [cluster('a/one.ts', ['a/one.ts'], ['ctx/x.ts', 'ctx/y.ts', 'b/one.ts'])] });
    expect(callers(changed, g, cl('a/one.ts'), true).map((c) => c.path)).toEqual(['ctx/x.ts', 'ctx/y.ts']);
    expect(callers(new Set([...CHANGED, 'ctx/x.ts']), g, cl('a/one.ts'), true).map((c) => c.path)).toEqual([
      'ctx/y.ts',
    ]);
  });
});

describe('groupOf', () => {
  it('names the cluster, then the bucket, that holds a path', () => {
    expect(groupOf(graph(), 'a/two.ts')).toEqual(cl('a/one.ts'));
    expect(groupOf(graph(), 'b/one.ts')).toEqual(cl('b/one.ts'));
    expect(groupOf(graph(), 'z/solo.ts')).toEqual(UNLINKED);
    expect(groupOf(graph(), 'docs/guide.md')).toEqual(OTHER);
  });

  it('is null for a path the graph does not hold, and without a graph', () => {
    expect(groupOf(graph(), 'new/file.ts')).toBeNull();
    expect(groupOf(null, 'a/one.ts')).toBeNull();
  });
});

describe('clusterAt', () => {
  it('picks the nth cluster, counting from 1 and skipping empty clusters and the buckets', () => {
    const g = graph({ clusters: [cluster('empty', []), cluster('a', ['a']), cluster('b', ['b'])] });
    expect(clusterAt(g, 1)).toEqual(cl('a'));
    expect(clusterAt(g, 2)).toEqual(cl('b'));
  });

  it('clamps a count past the last cluster to the last cluster, and a count below 1 to the first', () => {
    expect(clusterAt(graph(), 99)).toEqual(cl('b/one.ts'));
    expect(clusterAt(graph(), 0)).toEqual(cl('a/one.ts'));
  });

  it('is null when the graph has no cluster, buckets or not', () => {
    expect(clusterAt(graph({ clusters: [] }), 1)).toBeNull();
    expect(clusterAt(null, 1)).toBeNull();
  });
});

describe('canListContext', () => {
  const withCallers = graph({
    clusters: [{ ...cluster('a/one.ts', ['a/one.ts'], ['ctx/x.ts']), contextTotal: 23 }, cluster('b/one.ts', ['b'])],
  });

  it('holds only for a focused cluster that has unchanged callers', () => {
    expect(canListContext(withCallers, cl('a/one.ts'))).toBe(true);
    expect(canListContext(withCallers, cl('b/one.ts'))).toBe(false);
    expect(canListContext(withCallers, UNLINKED)).toBe(false);
    expect(canListContext(withCallers, OTHER)).toBe(false);
    expect(canListContext(withCallers, cl('gone.ts'))).toBe(false);
    expect(canListContext(withCallers, null)).toBe(false);
    expect(canListContext(null, cl('a/one.ts'))).toBe(false);
  });
});

describe('focus groups', () => {
  it('orders clusters, then unlinked, then other, and skips empty groups', () => {
    expect(focusGroups(graph())).toEqual([cl('a/one.ts'), cl('b/one.ts'), UNLINKED, OTHER]);
    expect(focusGroups(graph({ unlinked: [] }))).toEqual([cl('a/one.ts'), cl('b/one.ts'), OTHER]);
    expect(focusGroups(graph({ clusters: [], other: [] }))).toEqual([UNLINKED]);
    expect(focusGroups(graph({ clusters: [], unlinked: [], other: [] }))).toEqual([]);
    expect(focusGroups(graph({ clusters: [cluster('empty', [])] }))).toEqual([UNLINKED, OTHER]);
  });

  it('keeps a focus whose group still exists and falls back to the first group otherwise', () => {
    expect(keptFocus(graph(), cl('b/one.ts'))).toEqual(cl('b/one.ts'));
    expect(keptFocus(graph(), OTHER)).toEqual(OTHER);
    expect(keptFocus(graph(), cl('gone.ts'))).toEqual(cl('a/one.ts'));
    expect(keptFocus(graph({ other: [] }), OTHER)).toEqual(cl('a/one.ts'));
    expect(keptFocus(graph(), null)).toEqual(cl('a/one.ts'));
  });
});

describe('moveFocus', () => {
  it('cycles through clusters, then unlinked, then other, and wraps both ways', () => {
    const g = graph();
    expect(moveFocus(g, cl('a/one.ts'), 1)).toEqual(cl('b/one.ts'));
    expect(moveFocus(g, cl('b/one.ts'), 1)).toEqual(UNLINKED);
    expect(moveFocus(g, UNLINKED, 1)).toEqual(OTHER);
    expect(moveFocus(g, OTHER, 1)).toEqual(cl('a/one.ts'));
    expect(moveFocus(g, cl('a/one.ts'), -1)).toEqual(OTHER);
    expect(moveFocus(g, OTHER, -1)).toEqual(UNLINKED);
  });

  it('skips empty groups', () => {
    const g = graph({ unlinked: [] });
    expect(moveFocus(g, cl('b/one.ts'), 1)).toEqual(OTHER);
    expect(moveFocus(g, OTHER, -1)).toEqual(cl('b/one.ts'));
    expect(moveFocus(graph({ other: [] }), UNLINKED, 1)).toEqual(cl('a/one.ts'));
  });

  it('enters the cycle at its first group going forward and its last going back from no focus', () => {
    expect(moveFocus(graph(), null, 1)).toEqual(cl('a/one.ts'));
    expect(moveFocus(graph(), null, -1)).toEqual(OTHER);
    expect(moveFocus(graph(), cl('gone.ts'), 1)).toEqual(cl('a/one.ts'));
  });

  it('steps several groups at once, wrapping, for a counted gT', () => {
    const g = graph();
    expect(moveFocus(g, cl('a/one.ts'), -2)).toEqual(UNLINKED);
    expect(moveFocus(g, OTHER, 2)).toEqual(cl('b/one.ts'));
    expect(moveFocus(g, cl('a/one.ts'), -9)).toEqual(OTHER);
  });

  it('stays put on a single group and returns null when there is none', () => {
    const only = graph({ clusters: [], unlinked: [], other: ['README.md'] });
    expect(moveFocus(only, OTHER, 1)).toEqual(OTHER);
    expect(moveFocus(graph({ clusters: [], unlinked: [], other: [] }), null, 1)).toBeNull();
  });
});

describe('contextOf', () => {
  const withUses = graph({
    clusters: [
      {
        ...cluster('a/one.ts', ['a/one.ts', 'a/two.ts']),
        context: [
          { path: 'ctx/x.ts', refs: 4, uses: [{ symbol: 'one', kind: 12, path: 'src/lib.ts', lines: [42, 88] }] },
          { path: 'ctx/y.ts', refs: 1, uses: [{ symbol: 'two', kind: 12, path: 'src/lib.ts', lines: [3] }] },
        ],
      },
      cluster('b/one.ts', ['b/one.ts']),
    ],
  });

  it('returns the focused cluster’s callers in rank order, entries and all', () => {
    expect(contextOf(withUses, cl('a/one.ts')).map((c) => c.path)).toEqual(['ctx/x.ts', 'ctx/y.ts']);
    expect(contextOf(withUses, cl('a/one.ts'))[0]!.uses).toEqual([
      { symbol: 'one', kind: 12, path: 'src/lib.ts', lines: [42, 88] },
    ]);
  });

  it('has none for another group, a cluster the graph lacks, or no graph or focus', () => {
    expect(contextOf(withUses, cl('b/one.ts'))).toEqual([]);
    expect(contextOf(withUses, UNLINKED)).toEqual([]);
    expect(contextOf(withUses, OTHER)).toEqual([]);
    expect(contextOf(withUses, cl('gone.ts'))).toEqual([]);
    expect(contextOf(null, cl('a/one.ts'))).toEqual([]);
    expect(contextOf(withUses, null)).toEqual([]);
  });
});

describe('linkLines', () => {
  it('merges the lines of every use into one ascending list without repeats', () => {
    const entry = {
      path: 'ctx/x.ts',
      refs: 5,
      uses: [
        { symbol: 'one', kind: 12, path: 'src/lib.ts', lines: [88, 42] },
        { symbol: 'two', kind: 12, path: 'src/lib.ts', lines: [42, 7] },
      ],
    };
    expect(linkLines(entry)).toEqual([7, 42, 88]);
    expect(linkLines({ path: 'ctx/y.ts', refs: 0, uses: [] })).toEqual([]);
  });

  it('hands back the same list for the same entry, so the nav rows it feeds stay cached', () => {
    const entry = { path: 'ctx/x.ts', refs: 1, uses: [{ symbol: 'one', kind: 12, path: 'src/lib.ts', lines: [3] }] };
    expect(linkLines(entry)).toBe(linkLines(entry));
  });
});
