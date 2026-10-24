import { describe, expect, it } from 'vitest';
import type { GraphCluster, GraphLink, GraphUse } from '@/shared/protocol.js';
import { buildGraphModel, graphPending, MAX_NODES } from '@/client/connected/graph/model.js';

const use = (symbol: string, path: string, kind = 12): GraphUse => ({ symbol, kind, path, lines: [1] });
const link = (from: string, to: string, weight = 1): GraphLink => ({
  from,
  to,
  weight,
  uses: [use('fn', to)],
  total: 1,
});
const cluster = (files: string[], links: GraphLink[], extra: Partial<GraphCluster> = {}): GraphCluster => ({
  id: [...files].sort()[0] ?? '',
  label: 'src',
  files,
  symbols: 1,
  context: [],
  contextTotal: 0,
  links,
  linksTotal: links.length,
  ...extra,
});
const facts = (status = 'M') => ({ status, additions: 3, deletions: 1 });
const lookup = () => facts();
const shuffled = <T>(xs: T[], seed: number): T[] => {
  const out = [...xs];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

describe('buildGraphModel nodes', () => {
  it('makes a node per changed file with name, dir, counts and distinct-neighbour degrees', () => {
    const c = cluster(
      ['src/a.ts', 'src/b.ts', 'lib/c.ts'],
      [link('src/a.ts', 'src/b.ts'), link('lib/c.ts', 'src/b.ts')],
    );
    const m = buildGraphModel(
      c,
      (p) => (p === 'src/a.ts' ? { status: 'A', additions: 10, deletions: 0 } : facts()),
      false,
    );
    expect(m.nodes.map((n) => n.id)).toEqual(['lib/c.ts', 'src/a.ts', 'src/b.ts']);
    expect(m.nodes[1]).toEqual({
      id: 'src/a.ts',
      name: 'a.ts',
      dir: 'src',
      status: 'added',
      add: 10,
      del: 0,
      out: 1,
      in: 0,
      test: false,
    });
    expect(m.nodes[2]).toMatchObject({ name: 'b.ts', in: 2, out: 0, add: 3, del: 1 });
    expect(m.hiddenFiles).toBe(0);
    expect(m.hiddenLinks).toBe(0);
  });

  it.each([
    ['A', 'added'],
    ['M', 'modified'],
    ['D', 'deleted'],
    ['R', 'renamed'],
    ['C', 'modified'],
    ['T', 'modified'],
    ['U', 'modified'],
    ['?', 'modified'],
  ])('maps status letter %s to %s', (letter, status) => {
    const m = buildGraphModel(cluster(['a.ts', 'b.ts'], [link('a.ts', 'b.ts')]), () => facts(letter), false);
    expect(m.nodes.every((n) => n.status === status)).toBe(true);
  });

  it('treats a file the lookup does not know as an unchanged-count modified file', () => {
    const m = buildGraphModel(cluster(['top.ts', 'b.ts'], []), () => undefined, false);
    expect(m.nodes[1]).toMatchObject({ id: 'top.ts', dir: '', name: 'top.ts', status: 'modified', add: 0, del: 0 });
  });

  it('counts distinct neighbours once for a mutual pair', () => {
    const m = buildGraphModel(cluster(['a.ts', 'b.ts'], [link('a.ts', 'b.ts'), link('b.ts', 'a.ts')]), lookup, false);
    expect(m.nodes.map((n) => [n.id, n.in, n.out])).toEqual([
      ['a.ts', 1, 1],
      ['b.ts', 1, 1],
    ]);
    expect(m.edges.map((e) => e.id)).toEqual(['a.ts\u0000b.ts', 'b.ts\u0000a.ts']);
  });
});

describe('buildGraphModel cap', () => {
  const big = () => {
    const files = Array.from({ length: 70 }, (_, i) => `src/f${String(i).padStart(2, '0')}.ts`);
    // f00 is the hub; every other file links to it, and f69 also links to f68 (degree 2)
    const links = files.slice(1).map((f) => link(f, files[0]!));
    links.push(link(files[69]!, files[68]!));
    return { files, links };
  };

  it('keeps the 60 highest-degree files (ties by path), edges only between kept, and counts the rest', () => {
    const { files, links } = big();
    const m = buildGraphModel(cluster(files, links), lookup, false);
    expect(MAX_NODES).toBe(60);
    expect(m.nodes).toHaveLength(60);
    expect(m.hiddenFiles).toBe(10);
    const kept = new Set(m.nodes.map((n) => n.id));
    // hub (degree 69), f68 and f69 (degree 2) first; then degree-1 files by path
    expect(kept.has('src/f00.ts') && kept.has('src/f68.ts') && kept.has('src/f69.ts')).toBe(true);
    expect(kept.has('src/f57.ts')).toBe(true);
    expect(kept.has('src/f58.ts')).toBe(false);
    expect(m.edges.every((e) => kept.has(e.from) && kept.has(e.to))).toBe(true);
    // 70 links total; kept edges: f01..f57 -> f00 (57) + f68->f00 + f69->f00 + f69->f68 = 60
    expect(m.edges).toHaveLength(60);
    expect(m.hiddenLinks).toBe(10);
  });

  it('reports hidden links from the server total, including links the server itself capped', () => {
    const m = buildGraphModel(cluster(['a.ts', 'b.ts'], [link('a.ts', 'b.ts')], { linksTotal: 40 }), lookup, false);
    expect(m.hiddenLinks).toBe(39);
  });

  it('drops links whose end is not a changed file of the cluster', () => {
    const m = buildGraphModel(
      cluster(['a.ts', 'b.ts'], [link('a.ts', 'b.ts'), link('a.ts', 'gone.ts')]),
      lookup,
      false,
    );
    expect(m.edges.map((e) => e.to)).toEqual(['b.ts']);
    expect(m.hiddenLinks).toBe(1);
  });

  it('keeps every context node however many changed files are capped', () => {
    const { files, links } = big();
    const context = Array.from({ length: 15 }, (_, i) => ({
      path: `ctx/c${i}.ts`,
      refs: 1,
      uses: [use('fn', 'src/f00.ts')],
    }));
    const m = buildGraphModel(cluster(files, links, { context, contextTotal: 15 }), lookup, true);
    expect(m.nodes).toHaveLength(75);
    expect(m.hiddenFiles).toBe(10);
    expect(m.hiddenLinks).toBe(10);
  });
});

describe('buildGraphModel context', () => {
  const ctxCluster = () =>
    cluster(['src/a.ts', 'src/b.ts'], [link('src/a.ts', 'src/b.ts')], {
      context: [
        {
          path: 'ctx/x.ts',
          refs: 3,
          uses: [use('one', 'src/a.ts'), use('two', 'src/a.ts'), use('three', 'src/b.ts')],
        },
        { path: 'ctx/y.ts', refs: 1, uses: [use('one', 'src/a.ts')] },
      ],
      contextTotal: 2,
    });

  it('leaves unchanged callers out while context is off', () => {
    const m = buildGraphModel(ctxCluster(), lookup, false);
    expect(m.nodes.map((n) => n.id)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(m.edges.every((e) => !e.context)).toBe(true);
  });

  it('adds a context node per caller and one edge per (caller, used file) group', () => {
    const m = buildGraphModel(ctxCluster(), lookup, true);
    const ctx = m.nodes.filter((n) => n.status === 'context');
    expect(ctx.map((n) => [n.id, n.add, n.del, n.out, n.in])).toEqual([
      ['ctx/x.ts', 0, 0, 2, 0],
      ['ctx/y.ts', 0, 0, 1, 0],
    ]);
    const fromX = m.edges.filter((e) => e.from === 'ctx/x.ts');
    expect(fromX.map((e) => [e.to, e.weight, e.total, e.context, e.uses.map((u) => u.symbol)])).toEqual([
      ['src/a.ts', 2, 2, true, ['one', 'two']],
      ['src/b.ts', 1, 1, true, ['three']],
    ]);
    expect(m.nodes.find((n) => n.id === 'src/a.ts')).toMatchObject({ in: 2, out: 1 });
    expect(m.edges.find((e) => e.id === 'src/a.ts\u0000src/b.ts')?.context).toBe(false);
  });

  it('does not duplicate a caller that is also a changed file, and skips uses of unknown files', () => {
    const c = cluster(['src/a.ts', 'src/b.ts'], [], {
      context: [{ path: 'src/b.ts', refs: 1, uses: [use('one', 'src/a.ts')] }],
    });
    const m = buildGraphModel(c, lookup, true);
    expect(m.nodes.filter((n) => n.id === 'src/b.ts')).toHaveLength(1);
    expect(m.nodes.find((n) => n.id === 'src/b.ts')?.status).toBe('modified');
    expect(m.edges).toEqual([]);
    const lost = cluster(['src/a.ts', 'src/b.ts'], [], {
      context: [{ path: 'ctx/x.ts', refs: 1, uses: [use('one', 'nowhere.ts')] }],
    });
    expect(buildGraphModel(lost, lookup, true).edges).toEqual([]);
  });
});

describe('buildGraphModel order independence', () => {
  it('gives the same model for shuffled files, links and context', () => {
    const files = Array.from({ length: 70 }, (_, i) => `d${i % 4}/f${i}.ts`);
    const links = files.flatMap((f, i) => [link(f, files[(i * 7 + 1) % 70]!), link(f, files[(i * 3 + 2) % 70]!)]);
    const context = Array.from({ length: 5 }, (_, i) => ({
      path: `ctx/c${i}.ts`,
      refs: 1,
      uses: [use('a', files[i]!), use('b', files[i + 1]!)],
    }));
    const base = buildGraphModel(cluster(files, links, { context }), lookup, true);
    for (const seed of [1, 2, 3]) {
      const m = buildGraphModel(
        cluster(shuffled(files, seed), shuffled(links, seed + 10), { context: shuffled(context, seed + 20) }),
        lookup,
        true,
      );
      expect(m).toEqual(base);
    }
    const ids = base.nodes.map((n) => n.id);
    expect(ids).toEqual([...ids].sort());
    const eids = base.edges.map((e) => e.id);
    expect(eids).toEqual([...eids].sort());
  });
});

describe('graphPending', () => {
  const data = (version: number) => ({ version, clusters: [], unlinked: [], other: [] });

  it('is settled for a ready graph of the snapshot on screen, or for none', () => {
    expect(graphPending({ status: 'ready', data: data(4), error: null }, 4)).toBe(false);
    expect(graphPending({ status: 'error', data: null, error: 'x' }, 4)).toBe(false);
    expect(graphPending({ status: 'idle', data: null, error: null }, 4)).toBe(false);
  });

  it('is pending while a request is in flight, or while the graph is older than the snapshot', () => {
    expect(graphPending({ status: 'loading', data: data(4), error: null }, 4)).toBe(true);
    expect(graphPending({ status: 'ready', data: data(3), error: null }, 4)).toBe(true);
  });
});

describe('buildGraphModel tests', () => {
  const files = ['src/ledger.py', 'src/refunds.py', 'tests/test_ledger.py', 'tests/test_refunds.py'];
  const links = [
    link('src/refunds.py', 'src/ledger.py'),
    link('tests/test_ledger.py', 'src/ledger.py'),
    link('tests/test_refunds.py', 'src/refunds.py'),
    link('tests/test_refunds.py', 'tests/test_ledger.py'),
  ];

  it('flags a test file on its node and draws it while tests are shown', () => {
    const m = buildGraphModel(cluster(files, links), lookup, false);
    expect(m.nodes.map((n) => [n.id, n.test])).toEqual([
      ['src/ledger.py', false],
      ['src/refunds.py', false],
      ['tests/test_ledger.py', true],
      ['tests/test_refunds.py', true],
    ]);
    expect(m.edges).toHaveLength(4);
    expect(m.hiddenTests).toBe(0);
  });

  it('hides the test files and every arrow to or from them, and counts them', () => {
    const m = buildGraphModel(cluster(files, links), lookup, false, true);
    expect(m.nodes.map((n) => n.id)).toEqual(['src/ledger.py', 'src/refunds.py']);
    expect(m.edges.map((e) => e.id)).toEqual(['src/refunds.py\u0000src/ledger.py']);
    expect(m.nodes.map((n) => [n.in, n.out])).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(m.hiddenTests).toBe(2);
  });

  it('totals the files and links the cluster has once the tests are set aside', () => {
    const shown = buildGraphModel(cluster(files, links), lookup, false);
    const hidden = buildGraphModel(cluster(files, links), lookup, false, true);
    expect([shown.files, shown.links]).toEqual([4, 4]);
    expect([hidden.files, hidden.links]).toEqual([2, 1]);
  });

  it('does not report the arrows it hid with the tests as links left out', () => {
    const shown = buildGraphModel(cluster(files, links), lookup, false);
    const hidden = buildGraphModel(cluster(files, links), lookup, false, true);
    expect([shown.hiddenFiles, shown.hiddenLinks]).toEqual([0, 0]);
    expect([hidden.hiddenFiles, hidden.hiddenLinks]).toEqual([0, 0]);
  });

  it('spends the node cap on source files once tests are hidden', () => {
    const many = Array.from({ length: MAX_NODES + 5 }, (_, i) => `tests/t${String(i).padStart(2, '0')}.test.ts`);
    const all = [...many, 'src/a.ts', 'src/b.ts'];
    const m = buildGraphModel(cluster(all, [link('src/a.ts', 'src/b.ts')]), lookup, false, true);
    expect(m.nodes.map((n) => n.id)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(m.hiddenFiles).toBe(0);
    expect(m.hiddenTests).toBe(MAX_NODES + 5);
  });

  it('hides an unchanged test caller too, counting it only while context is on', () => {
    const context = [
      { path: 'tests/old.test.ts', refs: 1, uses: [use('one', 'src/ledger.py')] },
      { path: 'src/app.py', refs: 1, uses: [use('one', 'src/ledger.py')] },
    ];
    const c = cluster(files, links, { context, contextTotal: 2 });
    const hidden = buildGraphModel(c, lookup, true, true);
    expect(hidden.nodes.map((n) => n.id)).toEqual(['src/app.py', 'src/ledger.py', 'src/refunds.py']);
    expect(hidden.hiddenTests).toBe(3);
    expect(buildGraphModel(c, lookup, false, true).hiddenTests).toBe(2);
    const shown = buildGraphModel(c, lookup, true);
    expect(shown.nodes.find((n) => n.id === 'tests/old.test.ts')).toMatchObject({ test: true, status: 'context' });
  });
});
