import { describe, expect, it } from 'vitest';
import { split } from '@/client/graph/layout/components.js';
import { type Box, layout } from '@/client/graph/layout/layout.js';
import { byFile, rank } from '@/client/graph/layout/rank.js';
import { signatureOf } from '@/client/graph/details/useSignatures.js';
import { hiddenReason } from '@/client/graph/focus.js';
import { groupName } from '@/client/graph/PartHeader.js';
import { findMatches, type View } from '@/client/graph/state.js';
import type { GraphNode, GraphResponse } from '@/shared/protocol.js';

const node = (id: string, status: GraphNode['status'] = 'modified', path = `${id}.py`): GraphNode => ({
  id,
  name: id,
  kind: 12,
  path,
  line: 1,
  startLine: 1,
  endLine: 1,
  col: 0,
  status,
});

/** `a>b` is an edge: a uses b. */
function graph(nodes: GraphNode[], edges: string[]): GraphResponse {
  return {
    nodes,
    edges: edges.map((e) => {
      const [from, to] = e.split('>') as [string, string];
      return { from, to, lines: [1] };
    }),
    cut: [],
  };
}

const layers = (g: GraphResponse) => Object.fromEntries(rank(g).layer);

describe('rank', () => {
  it('lays a chain out from entry to core', () => {
    const g = graph(
      ['cli', 'runner', 'agent', 'http'].map((id) => node(id)),
      ['cli>runner', 'runner>agent', 'agent>http'],
    );
    expect(layers(g)).toEqual({ cli: 0, runner: 1, agent: 2, http: 3 });
  });

  it('puts a user just left of what it uses, aligning core code right', () => {
    const g = graph(
      ['cli', 'runner', 'agent', 'report'].map((id) => node(id)),
      ['cli>runner', 'runner>agent', 'report>agent'],
    );
    expect(layers(g)).toEqual({ cli: 0, runner: 1, agent: 2, report: 1 });
  });

  it('gives a cycle one layer and reports it', () => {
    const g = graph(
      ['a', 'b', 'c', 'd'].map((id) => node(id)),
      ['a>b', 'b>c', 'c>b', 'c>d'],
    );
    const ranked = rank(g);
    expect(Object.fromEntries(ranked.layer)).toEqual({ a: 0, b: 1, c: 1, d: 2 });
    expect(ranked.cycles.map((c) => [...c].sort())).toEqual([['b', 'c']]);
  });

  it('scores instability from uses and users', () => {
    const g = graph(
      ['a', 'b', 'c', 'lone'].map((id) => node(id)),
      ['a>b', 'a>c', 'b>c'],
    );
    expect(Object.fromEntries(rank(g).instability)).toEqual({ a: 1, b: 0.5, c: 0, lone: 0.5 });
  });
});

describe('byFile', () => {
  it('merges symbols into files, drops edges within a file and keeps the change status', () => {
    const g = graph(
      [
        node('run', 'modified', 'agent.py'),
        node('init', 'added', 'agent.py'),
        node('get', 'added', 'client.py'),
        node('main', 'consumer', 'cli.py'),
      ],
      ['main>run', 'run>init', 'run>get', 'init>get'],
    );
    const { graph: files, via } = byFile(g);
    expect(files.nodes.map((n) => [n.id, n.status])).toEqual([
      ['agent.py', 'modified'],
      ['client.py', 'added'],
      ['cli.py', 'consumer'],
    ]);
    expect(files.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['cli.py>agent.py', 'agent.py>client.py']);
    // The file arrow agent.py → client.py stands for both symbols there using `get`.
    expect(via.get('agent.py\0client.py')!.map((e) => `${e.from}>${e.to}`)).toEqual(['run>get', 'init>get']);
  });
});

describe('layout', () => {
  const size = () => ({ w: 140, h: 40 });
  const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  it('keeps boxes apart, layers in rank order top to bottom, and unlinked symbols on a shelf below', () => {
    const g = graph(
      [
        node('main', 'consumer', 'cli.py'),
        node('run', 'modified', 'agent.py'),
        node('init', 'added', 'agent.py'),
        node('get', 'modified', 'http.py'),
        node('lone', 'added', 'misc.py'),
      ],
      ['main>run', 'main>get', 'run>get', 'init>get'],
    );
    const placed = layout(g, rank(g), size, true);
    const at = new Map(placed.nodes.map((p) => [p.node.id, p]));
    expect(at.get('main')!.y).toBeLessThan(at.get('run')!.y);
    expect(at.get('run')!.y).toBeLessThan(at.get('get')!.y);
    for (const [i, a] of placed.nodes.entries())
      for (const b of placed.nodes.slice(i + 1)) expect(overlap(a, b), `${a.node.id} / ${b.node.id}`).toBe(false);
    expect(placed.shelf).not.toBeNull();
    expect(at.get('lone')!.y).toBeGreaterThanOrEqual(placed.shelf!);
    // One cluster per file and layer; the shelf's cluster has no layer.
    expect(placed.clusters.map((c) => [c.path, c.layer])).toEqual(
      expect.arrayContaining([
        ['agent.py', 1],
        ['misc.py', -1],
      ]),
    );
    // main uses get two layers on: its edge passes a waypoint, so it is two curves plus the straight run through it.
    const long = placed.edges.find((e) => e.edge.from === 'main' && e.edge.to === 'get')!;
    expect(long.d.match(/C/g)).toHaveLength(3);
  });

  it('spans every shelf row, not only the last and shortest', () => {
    const g = graph(
      Array.from({ length: 9 }, (_, i) => node(`lone${i}`, 'added', `f${i}.py`)),
      [],
    );
    const placed = layout(g, rank(g), size, false);
    expect(new Set(placed.nodes.map((p) => p.y)).size).toBeGreaterThan(1);
    for (const p of placed.nodes) expect(p.x + p.w, p.node.id).toBeLessThanOrEqual(placed.width);
  });

  it('keeps a file box in source order even where swapping its symbols would uncross arrows', () => {
    const at = (id: string, path: string, line: number) => ({ ...node(id, 'modified', path), line });
    const g = graph(
      [at('first', 'users.py', 1), at('second', 'users.py', 9), at('early', 'lib.py', 3), at('late', 'lib.py', 7)],
      ['first>late', 'second>early'],
    );
    const x = new Map(layout(g, rank(g), size, true).nodes.map((p) => [p.node.id, p.x]));
    expect(x.get('first')!).toBeLessThan(x.get('second')!);
    expect(x.get('early')!).toBeLessThan(x.get('late')!);
  });
});

describe('signatureOf', () => {
  it('keeps the code blocks a hover opens with and drops the docs after them', () => {
    const rust = '```rust\ndiffle::graph\n```\n\n```rust\npub fn link()\n```\n\n---\nLinks things.';
    expect(signatureOf(rust)).toBe('```rust\ndiffle::graph\n```\n\n```rust\npub fn link()\n```');
    expect(signatureOf('```python\ndef get(url: str)\n```\nGo to [str](x)')).toBe('```python\ndef get(url: str)\n```');
    expect(signatureOf('plain text')).toBe('plain text');
  });
});

describe('split', () => {
  it('parts the linked symbols by connection, largest first, and sets the unlinked apart', () => {
    const g = graph(
      ['a', 'b', 'c', 'x', 'y', 'lone'].map((id) => node(id)),
      ['a>b', 'b>c', 'x>y'],
    );
    const { parts, unlinked } = split(g);
    expect(parts.map((p) => p.nodes.map((n) => n.id))).toEqual([
      ['a', 'b', 'c'],
      ['x', 'y'],
    ]);
    expect(unlinked.nodes.map((n) => n.id)).toEqual(['lone']);
  });
});

describe('groupName', () => {
  const file = (path: string) => ({ ...node(path), kind: 1, path });

  it('names a file view group by the folder its files share, else by its hub', () => {
    const hub = file('pkg/core/tools.py');
    expect(groupName(hub, [hub, file('pkg/core/agent.py'), file('pkg/core/sub/x.py')], true)).toEqual({
      folder: 'pkg/core',
    });
    expect(groupName(hub, [hub, file('pkg/coreutils/a.py')], true)).toEqual({ folder: 'pkg' });
    expect(groupName(hub, [hub, file('main.py')], true)).toEqual({ hub });
    expect(groupName(hub, [hub, file('pkg/core/agent.py')], false)).toEqual({ hub });
  });
});

describe('findMatches', () => {
  const at = (n: GraphNode, x: number, y: number) => ({ node: n, x, y, w: 10, h: 10 });
  const view = (...nodes: ReturnType<typeof at>[]) => ({ stacked: { nodes } }) as unknown as View;

  it('matches box names ignoring case, a file by its path, in reading order', () => {
    const v = view(
      at(node('total_by_day'), 50, 100),
      at(node('Total'), 0, 100),
      at(node('subtotal'), 90, 0),
      at({ ...node('x'), kind: 1, path: 'pkg/totals.py' }, 0, 200),
      at(node('other'), 0, 0),
    );
    expect(findMatches(v, ' total ')).toEqual(['subtotal', 'Total', 'total_by_day', 'x']);
    expect(findMatches(v, '')).toEqual([]);
  });
});

describe('hiddenReason', () => {
  const g = {
    ...graph(
      [
        node('run', 'modified', 'pkg/run.py'),
        node('t', 'modified', 'tests/test_run.py'),
        node('use', 'consumer', 'cli.py'),
      ],
      [],
    ),
    cut: [node('late', 'modified', 'pkg/late.py')],
  };
  const shown = { drawn: new Set(['pkg/run.py']), graph: g, filters: { consumers: false, tests: false }, scope: 'pkg' };

  it('says why a picked file has no box, or that another part shown alone hides it', () => {
    const why = (path: string, over = {}) => hiddenReason({ ...shown, ...over }, path);
    expect({
      drawn: why('pkg/run.py'),
      test: why('tests/test_run.py'),
      dependent: why('cli.py'),
      otherPart: why('cli.py', { filters: { consumers: true, tests: false } }),
      cut: why('pkg/late.py'),
      outside: why('docs/conf.py'),
      nothing: why('pkg/empty.py'),
    }).toEqual({
      drawn: null,
      test: 'test_run.py is test code, and tests are hidden: T shows them',
      dependent: 'cli.py only uses the change, and dependents are hidden: d shows them',
      otherPart: 'only',
      cut: 'late.py did not fit in the graph: see Not in the graph',
      outside: 'conf.py is outside pkg/, the folder the graph shows',
      nothing: 'empty.py has no changed function, class or type, and uses none',
    });
  });
});
