import { describe, expect, it } from 'vitest';
import { parseRevspec, RevspecError } from '../../src/server/revspec.js';

describe('parseRevspec', () => {
  it('single rev diffs its merge base with HEAD against HEAD', () => {
    expect(parseRevspec(['main'])).toEqual({
      old: 'main',
      base: 'merge-base',
      new: 'HEAD',
    });
    expect(parseRevspec(['main'])).toEqual(parseRevspec(['main...HEAD']));
  });

  it('names the uncommitted tree on the new side of any form', () => {
    expect(parseRevspec(['main..worktree'])).toEqual({
      old: 'main',
      base: 'direct',
      new: 'worktree',
    });
    // A merge base needs a commit, and the worktree sits on HEAD.
    expect(parseRevspec(['main...worktree'])).toEqual({
      old: 'main',
      base: 'merge-base',
      new: 'worktree',
    });
    expect(parseRevspec(['main', 'worktree']).new).toBe('worktree');
    expect(parseRevspec(['worktree'])).toEqual({
      old: 'HEAD',
      base: 'direct',
      new: 'worktree',
    });
  });

  it('two-dot is a direct comparison', () => {
    expect(parseRevspec(['main..feat'])).toEqual({
      old: 'main',
      base: 'direct',
      new: 'feat',
    });
  });

  it('three-dot uses the merge base', () => {
    expect(parseRevspec(['main...feat'])).toEqual({
      old: 'main',
      base: 'merge-base',
      new: 'feat',
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

  it('^! names one commit, compared with its parent', () => {
    expect(parseRevspec(['feat^!'])).toEqual({ old: 'feat', new: 'feat', base: 'parent' });
    expect(parseRevspec(['^!']).new).toBe('HEAD');
  });

  it('rejects mixed forms and bad arity', () => {
    expect(() => parseRevspec(['a..b', 'c'])).toThrow(RevspecError);
    expect(() => parseRevspec(['a..b^!'])).toThrow(RevspecError);
    expect(() => parseRevspec(['a^!', 'b'])).toThrow(RevspecError);
    expect(() => parseRevspec(['worktree^!'])).toThrow(RevspecError);
    expect(() => parseRevspec([])).toThrow(RevspecError);
    expect(() => parseRevspec(['a', 'b', 'c'])).toThrow(RevspecError);
  });
});
