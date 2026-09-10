import { describe, expect, it } from 'vitest';
import { parseRevspec, RevspecError } from '../../src/server/revspec.js';

describe('parseRevspec', () => {
  it('single rev diffs its merge base with HEAD against HEAD', () => {
    expect(parseRevspec(['main'])).toEqual({
      old: 'main',
      mergeBase: true,
      new: 'HEAD',
      label: 'main...HEAD',
    });
    expect(parseRevspec(['main'])).toEqual(parseRevspec(['main...HEAD']));
  });

  // An ancestor of HEAD is its own merge base with HEAD, so this reads as the last three commits.
  it('sends a lone ancestor of HEAD through the merge base too', () => {
    expect(parseRevspec(['HEAD~3'])).toEqual({
      old: 'HEAD~3',
      mergeBase: true,
      new: 'HEAD',
      label: 'HEAD~3...HEAD',
    });
  });

  it('names the uncommitted tree on the new side of any form', () => {
    expect(parseRevspec(['main..worktree'])).toEqual({
      old: 'main',
      mergeBase: false,
      new: 'worktree',
      label: 'main..worktree',
    });
    // A merge base needs a commit, and the worktree sits on HEAD.
    expect(parseRevspec(['main...worktree'])).toEqual({
      old: 'main',
      mergeBase: true,
      new: 'worktree',
      label: 'main...worktree',
    });
    expect(parseRevspec(['main', 'worktree']).new).toBe('worktree');
    expect(parseRevspec(['worktree'])).toEqual({
      old: 'HEAD',
      mergeBase: false,
      new: 'worktree',
      label: 'HEAD..worktree',
    });
  });

  it('two-dot is a direct comparison', () => {
    expect(parseRevspec(['main..feat'])).toEqual({
      old: 'main',
      mergeBase: false,
      new: 'feat',
      label: 'main..feat',
    });
  });

  it('three-dot uses the merge base', () => {
    expect(parseRevspec(['main...feat'])).toEqual({
      old: 'main',
      mergeBase: true,
      new: 'feat',
      label: 'main...feat',
    });
  });

  it('empty sides default to HEAD', () => {
    expect(parseRevspec(['..feat']).old).toBe('HEAD');
    expect(parseRevspec(['main..']).new).toBe('HEAD');
    expect(parseRevspec(['main...']).new).toBe('HEAD');
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
