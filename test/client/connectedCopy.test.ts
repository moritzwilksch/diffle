import { describe, expect, it } from 'vitest';
import {
  arrowSentence,
  contextToggleTitle,
  hideTestsTitle,
  elapsedLabel,
  graphButtonTitle,
  graphCounts,
  plural,
} from '@/client/connected/clusters/copy.js';

describe('elapsedLabel', () => {
  it('says nothing for the first seconds, so a quick analysis never flashes a timer', () => {
    expect(elapsedLabel(0)).toBe('');
    expect(elapsedLabel(2999)).toBe('');
  });

  it('counts whole seconds from the third', () => {
    expect(elapsedLabel(3000)).toBe('3 s');
    expect(elapsedLabel(12_400)).toBe('12 s');
    expect(elapsedLabel(61_999)).toBe('61 s');
  });
});

describe('plural', () => {
  it('adds an s except for exactly one', () => {
    expect(plural(0, 'file')).toBe('0 files');
    expect(plural(1, 'file')).toBe('1 file');
    expect(plural(2, 'file')).toBe('2 files');
  });
});

describe('contextToggleTitle', () => {
  const cluster = { kind: 'cluster', id: 'a.ts' } as const;

  it('says how many of the callers the list shows when the server capped it', () => {
    expect(contextToggleTitle(cluster, 15, 23)).toBe('List 15 of 23 unchanged files that call into this cluster (gc)');
  });

  it('names the callers without a fraction when all of them are listed', () => {
    expect(contextToggleTitle(cluster, 4, 4)).toBe('List the 4 unchanged files that call into this cluster (gc)');
    expect(contextToggleTitle(cluster, 1, 1)).toBe('List the unchanged file that calls into this cluster (gc)');
  });

  it('gives the reason when there is nothing to list', () => {
    expect(contextToggleTitle(cluster, 0, 0)).toBe('This cluster has no unchanged callers to list');
    expect(contextToggleTitle({ kind: 'other' }, 0, 0)).toBe('Only a cluster lists unchanged callers');
    expect(contextToggleTitle({ kind: 'unlinked' }, 0, 0)).toBe('Only a cluster lists unchanged callers');
    expect(contextToggleTitle(null, 0, 0)).toBe('Only a cluster lists unchanged callers');
  });
});

describe('contextToggleTitle without the key hint', () => {
  it('leaves the (gc) out where the key is silent, and keeps the rest', () => {
    const cluster = { kind: 'cluster', id: 'a.ts' } as const;
    expect(contextToggleTitle(cluster, 15, 23, false)).toBe(
      'List 15 of 23 unchanged files that call into this cluster',
    );
    expect(contextToggleTitle(cluster, 1, 1, false)).toBe('List the unchanged file that calls into this cluster');
    expect(contextToggleTitle(cluster, 4, 4, false)).toBe('List the 4 unchanged files that call into this cluster');
    expect(contextToggleTitle(cluster, 0, 0, false)).toBe('This cluster has no unchanged callers to list');
  });
});

describe('graphButtonTitle', () => {
  const cluster = { kind: 'cluster', id: 'a.ts' } as const;

  it('names the key when a cluster can be drawn', () => {
    expect(graphButtonTitle(cluster)).toBe('Show how this cluster’s files connect (gm)');
  });

  it('says to pick a cluster for a bucket or no focus', () => {
    const reason = 'Pick a cluster: only linked files can be drawn';
    expect(graphButtonTitle({ kind: 'unlinked' })).toBe(reason);
    expect(graphButtonTitle({ kind: 'other' })).toBe(reason);
    expect(graphButtonTitle(null)).toBe(reason);
  });
});

describe('graphCounts', () => {
  it('counts files and links, then the unchanged callers', () => {
    expect(graphCounts({ files: 4, links: 5, callers: 2, callersDrawn: true, testsHidden: 0 })).toBe(
      '4 files · 5 links · 2 unchanged callers',
    );
  });

  it('says callers are hidden while + context is off, and leaves them out when there are none', () => {
    expect(graphCounts({ files: 2, links: 1, callers: 1, callersDrawn: false, testsHidden: 0 })).toBe(
      '2 files · 1 link · 1 unchanged caller (hidden)',
    );
    expect(graphCounts({ files: 2, links: 0, callers: 0, callersDrawn: false, testsHidden: 0 })).toBe(
      '2 files · 0 links',
    );
  });
});

describe('arrowSentence', () => {
  const arrow = (
    symbols: string[],
    total = symbols.length,
    from = 'crates/x/facts_tests.rs',
    to = 'crates/x/facts.rs',
  ) => ({
    from,
    to,
    uses: symbols.map((symbol) => ({ symbol })),
    total,
  });

  it('says who uses what from whom, by file name without the directory', () => {
    expect(arrowSentence(arrow(['UnitFacts']))).toBe('facts_tests.rs uses UnitFacts from facts.rs');
    expect(arrowSentence(arrow(['UnitFacts', 'UnitArea']))).toBe(
      'facts_tests.rs uses UnitFacts and UnitArea from facts.rs',
    );
    expect(arrowSentence(arrow(['A', 'B', 'C']))).toBe('facts_tests.rs uses A, B and C from facts.rs');
  });

  it('names three symbols and counts the rest, including those the server capped', () => {
    expect(arrowSentence(arrow(['A', 'B', 'C', 'D']))).toBe('facts_tests.rs uses A, B, C and 1 more from facts.rs');
    expect(arrowSentence(arrow(['A', 'B', 'C', 'D'], 9))).toBe('facts_tests.rs uses A, B, C and 6 more from facts.rs');
  });

  it('still reads when the arrow names no symbol', () => {
    expect(arrowSentence(arrow([], 0))).toBe('facts_tests.rs uses facts.rs');
  });

  it('keeps a directory where two files share a name, so the sentence is not ambiguous', () => {
    expect(arrowSentence(arrow(['x'], 1, 'a/mod.rs', 'b/mod.rs'))).toBe('a/mod.rs uses x from b/mod.rs');
  });
});

describe('graphCounts with tests hidden', () => {
  it('adds how many tests the drawing leaves out, and says nothing for none', () => {
    expect(graphCounts({ files: 5, links: 9, callers: 0, callersDrawn: false, testsHidden: 2 })).toBe(
      '5 files · 9 links · 2 tests hidden',
    );
    expect(graphCounts({ files: 5, links: 9, callers: 1, callersDrawn: true, testsHidden: 1 })).toBe(
      '5 files · 9 links · 1 unchanged caller · 1 test hidden',
    );
    expect(graphCounts({ files: 5, links: 9, callers: 0, callersDrawn: false, testsHidden: 0 })).toBe(
      '5 files · 9 links',
    );
  });
});

describe('hideTestsTitle', () => {
  it('offers to hide the tests, and to bring them back once hidden', () => {
    expect(hideTestsTitle(2, 5, false)).toEqual({ usable: true, title: 'Hide the 2 test files' });
    expect(hideTestsTitle(1, 5, false)).toEqual({ usable: true, title: 'Hide the 1 test file' });
    expect(hideTestsTitle(2, 5, true)).toEqual({ usable: true, title: 'Show the 2 test files again' });
  });

  it('says why there is nothing to hide: no tests, or nothing but tests', () => {
    expect(hideTestsTitle(0, 5, false)).toEqual({ usable: false, title: 'This cluster has no test files to hide' });
    expect(hideTestsTitle(3, 3, false)).toEqual({
      usable: false,
      title: 'Every file of this cluster is a test, so hiding them would leave nothing',
    });
  });
});
