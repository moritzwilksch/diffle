import { describe, expect, it } from 'vitest';
import { fuzzyFilter, fuzzyRank, fuzzyScore } from '../../src/shared/fuzzy.js';

const names = [
  'AbstractBuilderFactory',
  'AbstractBaseFormatter',
  'abs_buffer_flush',
  'evaluate_run_cases.py',
  'eval_rules.py',
  'every_cache.py',
  'parse_args',
  'argparse',
  'apply',
];
const rank = (query: string) => fuzzyFilter(names, query, (s) => s);

describe('fuzzyScore', () => {
  it('matches word-start prefixes across camelCase humps and separators', () => {
    expect(rank('AbsBuiFa')[0]).toBe('AbstractBuilderFactory');
    expect(rank('evruca')[0]).toBe('evaluate_run_cases.py');
    // Every word start counts, whatever the casing; tighter matches win the tie.
    expect(rank('ABF')).toEqual(['abs_buffer_flush', 'AbstractBaseFormatter', 'AbstractBuilderFactory']);
  });

  it('ranks a prefix over a later substring, and both over a scattered subsequence', () => {
    expect(rank('arg')).toEqual(['argparse', 'parse_args']);
    expect(rank('pars')).toEqual(['parse_args', 'argparse']);
    expect(rank('ply')).toEqual(['apply']);
  });

  it('ignores case, keeps order, and rejects what is not a subsequence', () => {
    expect(rank('absbuifa')[0]).toBe('AbstractBuilderFactory');
    expect(rank('EVRUCA')[0]).toBe('evaluate_run_cases.py');
    expect(fuzzyScore('fab', 'AbstractBuilderFactory')).toBeNull();
    expect(fuzzyScore('toolong', 'tool')).toBeNull();
    expect(fuzzyScore('', 'x')).toBe(0);
  });

  it('a blank query keeps every item in order', () => {
    expect(rank('  ')).toEqual(names);
  });

  it('fuzzyRank re-ranks matches and keeps the rest after them', () => {
    expect(fuzzyRank(['zzz', 'parse_args', 'argparse'], 'arg', (s) => s)).toEqual(['argparse', 'parse_args', 'zzz']);
  });
});
