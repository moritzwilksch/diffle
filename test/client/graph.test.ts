import { describe, expect, it } from 'vitest';
import { type Box, layout } from '@/client/graph/layout.js';
import { byFile, rank } from '@/client/graph/rank.js';
import { signatureOf } from '@/client/graph/useSignatures.js';
import type { GraphNode, GraphResponse } from '@/shared/protocol.js';

const node = (id: string, status: GraphNode['status'] = 'modified', path = `${id}.py`): GraphNode => ({
  id,
  name: id,
  kind: 12,
  path,
  line: 1,
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
    truncated: false,
  };
}

const columns = (g: GraphResponse) => Object.fromEntries(rank(g).column);

describe('rank', () => {
  it('lays a chain out from entry to core', () => {
    const g = graph(
      ['cli', 'runner', 'agent', 'http'].map((id) => node(id)),
      ['cli>runner', 'runner>agent', 'agent>http'],
    );
    expect(columns(g)).toEqual({ cli: 0, runner: 1, agent: 2, http: 3 });
  });

  it('puts a user just left of what it uses, aligning core code right', () => {
    const g = graph(
      ['cli', 'runner', 'agent', 'report'].map((id) => node(id)),
      ['cli>runner', 'runner>agent', 'report>agent'],
    );
    expect(columns(g)).toEqual({ cli: 0, runner: 1, agent: 2, report: 1 });
  });

  it('gives a cycle one column and reports it', () => {
    const g = graph(
      ['a', 'b', 'c', 'd'].map((id) => node(id)),
      ['a>b', 'b>c', 'c>b', 'c>d'],
    );
    const ranked = rank(g);
    expect(Object.fromEntries(ranked.column)).toEqual({ a: 0, b: 1, c: 1, d: 2 });
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
    const files = byFile(g);
    expect(files.nodes.map((n) => [n.id, n.status])).toEqual([
      ['agent.py', 'modified'],
      ['client.py', 'added'],
      ['cli.py', 'consumer'],
    ]);
    expect(files.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['cli.py>agent.py', 'agent.py>client.py']);
  });
});

describe('layout', () => {
  const size = () => ({ w: 140, h: 40 });
  const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  it('keeps boxes apart, columns in rank order, and unlinked symbols on a shelf below', () => {
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
    expect(at.get('main')!.x).toBeLessThan(at.get('run')!.x);
    expect(at.get('run')!.x).toBeLessThan(at.get('get')!.x);
    for (const [i, a] of placed.nodes.entries())
      for (const b of placed.nodes.slice(i + 1)) expect(overlap(a, b), `${a.node.id} / ${b.node.id}`).toBe(false);
    expect(placed.shelf).not.toBeNull();
    expect(at.get('lone')!.y).toBeGreaterThanOrEqual(placed.shelf!);
    // One cluster per file and column; the shelf's cluster has no column.
    expect(placed.clusters.map((c) => [c.path, c.column])).toEqual(
      expect.arrayContaining([
        ['agent.py', 1],
        ['misc.py', -1],
      ]),
    );
    // main uses get two columns on: its edge passes a waypoint, so it is two curve segments plus one across.
    const long = placed.edges.find((e) => e.edge.from === 'main' && e.edge.to === 'get')!;
    expect(long.d.match(/C/g)).toHaveLength(3);
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
