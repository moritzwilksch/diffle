import { describe, expect, it } from 'vitest';
import type { GraphCluster, GraphLink } from '@/shared/protocol.js';
import { clusterTitle } from '@/client/connected/clusters/clusterTitle.js';
import { isTestPath } from '@/client/connected/clusters/testPath.js';

const link = (from: string, to: string, weight = 1): GraphLink => ({
  from,
  to,
  weight,
  uses: [{ symbol: 'fn', kind: 12, path: to, lines: [1] }],
  total: 1,
});
const cluster = (files: string[], links: GraphLink[], label = 'crates/diffle/src/git'): GraphCluster => ({
  id: [...files].sort()[0] ?? '',
  label,
  files,
  symbols: 1,
  context: [],
  contextTotal: 0,
  links,
  linksTotal: links.length,
});

describe('isTestPath', () => {
  it.each([
    'src/a.test.ts',
    'src/a.spec.tsx',
    'src/a_test.rs',
    'src/foo_tests.rs',
    'src/tests.rs',
    'pkg/test_ledger.py',
    'pkg/ledger_test.go',
    'crates/x/tests/common/mod.rs',
    'src/__tests__/a.ts',
    'test/client/a.ts',
    'test/e2e/a.ts',
    'e2e/a.ts',
    'src/fixtures/a.json',
    'src/testdata/a.txt',
    'Tests/Foo.cs',
  ])('%s is a test file', (path) => expect(isTestPath(path)).toBe(true));

  it.each([
    'src/a.ts',
    'src/testing.ts',
    'src/latest.rs',
    'src/test.py',
    'src/contest/a.ts',
    'src/a.test',
    'src/protests.rs',
    'src/mytests.rs',
    'src/testify_a.py',
    'crates/diffle/src/facts.rs',
  ])('%s is not', (path) => expect(isTestPath(path)).toBe(false));
});

describe('clusterTitle', () => {
  const facts = 'crates/diffle/src/git/facts.rs';

  it('names the cluster by the source file the most arrow weight points at', () => {
    const c = cluster(
      [facts, 'crates/diffle/src/git/mod.rs', 'crates/diffle/src/git/facts_tests.rs'],
      [
        link('crates/diffle/src/git/facts_tests.rs', facts, 2),
        link('crates/diffle/src/git/mod.rs', facts, 3),
        link(facts, 'crates/diffle/src/git/mod.rs', 1),
      ],
    );
    expect(clusterTitle(c)).toBe('facts.rs');
  });

  it('never picks a test file, however many arrows point at it', () => {
    const c = cluster(
      ['src/a.ts', 'src/b.ts', 'src/helpers.test.ts'],
      [
        link('src/a.ts', 'src/helpers.test.ts', 9),
        link('src/b.ts', 'src/helpers.test.ts', 9),
        link('src/b.ts', 'src/a.ts'),
      ],
    );
    expect(clusterTitle(c)).toBe('a.ts');
  });

  it('breaks a weight tie by more links, then by path', () => {
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];
    const moreLinks = cluster(files, [
      link('src/c.ts', 'src/a.ts', 2),
      link('src/c.ts', 'src/b.ts', 1),
      link('src/d.ts', 'src/b.ts', 1),
    ]);
    expect(clusterTitle(moreLinks)).toBe('b.ts');
    const byPath = cluster(files, [link('src/c.ts', 'src/b.ts', 2), link('src/d.ts', 'src/a.ts', 2)]);
    expect(clusterTitle(byPath)).toBe('a.ts');
  });

  it('falls back to the smallest source member when nothing source is pointed at', () => {
    expect(clusterTitle(cluster(['src/z.ts', 'src/m.ts', 'src/a.test.ts'], []))).toBe('m.ts');
    const testTargets = cluster(['src/z.ts', 'src/m.ts', 'src/a.test.ts'], [link('src/z.ts', 'src/a.test.ts')]);
    expect(clusterTitle(testTargets)).toBe('m.ts');
  });

  it('falls back to the folder when every member is a test', () => {
    expect(clusterTitle(cluster(['t/a.test.ts', 't/b.test.ts'], [], 't'))).toBe('t');
    expect(clusterTitle(cluster(['a.test.ts', 'b.test.ts'], [], ''))).toBe('(root)');
  });

  it('ignores arrows that leave the cluster, and does not depend on member or link order', () => {
    const links = [
      link('src/a.ts', 'src/b.ts', 2),
      link('src/b.ts', 'src/c.ts', 2),
      link('src/a.ts', 'elsewhere/x.ts', 9),
    ];
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
    expect(clusterTitle(cluster(files, links))).toBe('b.ts');
    expect(clusterTitle(cluster([...files].reverse(), [...links].reverse()))).toBe('b.ts');
  });
});
