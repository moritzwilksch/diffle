import { describe, expect, it } from 'vitest';
import { byFile, rank } from '@/client/graph/rank.js';
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
