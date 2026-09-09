import { describe, expect, it } from 'vitest';
import { parseRevspec, RevspecError } from '../../src/server/revspec.js';

describe('parseRevspec', () => {
  it('single rev diffs its merge base with HEAD against HEAD', () => {
    expect(parseRevspec(['main'])).toEqual({
      old: { kind: 'merge-base', a: 'main', b: 'HEAD' },
      newRev: 'HEAD',
      label: 'main...HEAD',
    });
    expect(parseRevspec(['main'])).toEqual(parseRevspec(['main...HEAD']));
  });

  // An ancestor of HEAD is its own merge base with HEAD, so this reads as the last three commits.
  it('sends a lone ancestor of HEAD through the merge base too', () => {
    expect(parseRevspec(['HEAD~3'])).toEqual({
      old: { kind: 'merge-base', a: 'HEAD~3', b: 'HEAD' },
      newRev: 'HEAD',
      label: 'HEAD~3...HEAD',
    });
  });

  it('names the uncommitted tree on the new side of any form', () => {
    expect(parseRevspec(['main..worktree'])).toEqual({
      old: { kind: 'rev', rev: 'main' },
      newRev: 'worktree',
      label: 'main..worktree',
    });
    // A merge base needs a commit, and the worktree sits on HEAD.
    expect(parseRevspec(['main...worktree'])).toEqual({
      old: { kind: 'merge-base', a: 'main', b: 'HEAD' },
      newRev: 'worktree',
      label: 'main...worktree',
    });
    expect(parseRevspec(['main', 'worktree']).newRev).toBe('worktree');
    expect(parseRevspec(['worktree'])).toEqual({
      old: { kind: 'rev', rev: 'HEAD' },
      newRev: 'worktree',
      label: 'HEAD..worktree',
    });
  });

  it('two-dot is a direct comparison', () => {
    expect(parseRevspec(['main..feat'])).toEqual({
      old: { kind: 'rev', rev: 'main' },
      newRev: 'feat',
      label: 'main..feat',
    });
  });

  it('three-dot uses the merge base', () => {
    expect(parseRevspec(['main...feat'])).toEqual({
      old: { kind: 'merge-base', a: 'main', b: 'feat' },
      newRev: 'feat',
      label: 'main...feat',
    });
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
