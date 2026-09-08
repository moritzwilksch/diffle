import { describe, expect, it } from 'vitest';
import { parseRevspec, RevspecError } from '../../src/server/revspec.js';

describe('parseRevspec', () => {
  it('single rev diffs against the worktree', () => {
    expect(parseRevspec(['HEAD~3'])).toEqual({ old: { kind: 'rev', rev: 'HEAD~3' }, newRev: 'worktree', label: 'HEAD~3 → worktree' });
  });

  it('two-dot is a direct comparison', () => {
    expect(parseRevspec(['main..feat'])).toEqual({ old: { kind: 'rev', rev: 'main' }, newRev: 'feat', label: 'main..feat' });
  });

  it('three-dot uses the merge base', () => {
    expect(parseRevspec(['main...feat'])).toEqual({ old: { kind: 'merge-base', a: 'main', b: 'feat' }, newRev: 'feat', label: 'main...feat' });
  });

  it('empty sides default to HEAD', () => {
    expect(parseRevspec(['..feat']).old).toEqual({ kind: 'rev', rev: 'HEAD' });
    expect(parseRevspec(['main..']).newRev).toBe('HEAD');
    expect(parseRevspec(['main...']).newRev).toBe('HEAD');
  });

  it('two positional revs equal a..b', () => {
    expect(parseRevspec(['a', 'b'])).toEqual(parseRevspec(['a..b']));
  });

  it('rejects mixed forms and bad arity', () => {
    expect(() => parseRevspec(['a..b', 'c'])).toThrow(RevspecError);
    expect(() => parseRevspec([])).toThrow(RevspecError);
    expect(() => parseRevspec(['a', 'b', 'c'])).toThrow(RevspecError);
  });
});
