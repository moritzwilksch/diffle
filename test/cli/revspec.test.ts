import { describe, expect, it } from 'vitest';
import { parseRangeDiff, parseRevspec, RevspecError } from '../../src/server/revspec.js';

describe('parseRangeDiff', () => {
  it('takes two ranges, each old..new with empty sides defaulting to HEAD', () => {
    expect(parseRangeDiff(['main..v1', 'main..v2'])).toEqual([
      { old: 'main', new: 'v1' },
      { old: 'main', new: 'v2' },
    ]);
    expect(parseRangeDiff(['main..', '..v2'])).toEqual([
      { old: 'main', new: 'HEAD' },
      { old: 'HEAD', new: 'v2' },
    ]);
  });

  it('takes a base and two tips as git range-diff does', () => {
    expect(parseRangeDiff(['main', 'v1', 'v2'])).toEqual(parseRangeDiff(['main..v1', 'main..v2']));
  });

  it("takes rev1...rev2 as each tip's commits since the other", () => {
    expect(parseRangeDiff(['v1...v2'])).toEqual(parseRangeDiff(['v2..v1', 'v1..v2']));
    expect(parseRangeDiff(['v1...'])).toEqual(parseRangeDiff(['HEAD..v1', 'v1..HEAD']));
  });

  it('takes ^! as the one commit', () => {
    expect(parseRangeDiff(['a^!', 'b^!'])).toEqual([
      { old: 'a^', new: 'a' },
      { old: 'b^', new: 'b' },
    ]);
  });

  it('rejects the worktree, lone revisions and mixed forms', () => {
    expect(() => parseRangeDiff(['main..worktree', 'main..v2'])).toThrow(RevspecError);
    expect(() => parseRangeDiff(['main', 'worktree', 'v2'])).toThrow(RevspecError);
    expect(() => parseRangeDiff(['main..v1'])).toThrow(RevspecError);
    expect(() => parseRangeDiff(['main', 'v1'])).toThrow(RevspecError);
    expect(() => parseRangeDiff(['main...v1', 'main..v2'])).toThrow(RevspecError);
    expect(() => parseRangeDiff(['main..a', 'v1', 'v2'])).toThrow(RevspecError);
    expect(() => parseRangeDiff(['a..b^!', 'c..d'])).toThrow(RevspecError);
    expect(() => parseRangeDiff([])).toThrow(RevspecError);
    expect(() => parseRangeDiff(['a', 'b', 'c', 'd'])).toThrow(RevspecError);
  });
});

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
