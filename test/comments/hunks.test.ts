import { describe, expect, it } from 'vitest';
import { isShown, shownRanges } from '../../src/server/comments/hunks.js';

const patch = [
  'diff --git a/f.txt b/f.txt',
  '--- a/f.txt',
  '+++ b/f.txt',
  '@@ -1,4 +1,5 @@',
  ' a',
  '+b',
  ' c',
  ' d',
  ' e',
  '@@ -20 +21,2 @@ fn()',
  ' x',
  '+y',
  '',
].join('\n');

describe('shownRanges', () => {
  it('reads each hunk span per side, defaulting an omitted count to one', () => {
    expect(shownRanges(patch, 'old')).toEqual([[1, 4], [20, 20]]);
    expect(shownRanges(patch, 'new')).toEqual([[1, 5], [21, 22]]);
  });

  it('shows nothing for an empty side, a binary patch, or no patch', () => {
    expect(shownRanges('@@ -0,0 +1,2 @@\n+a\n+b\n', 'old')).toEqual([]);
    expect(shownRanges('@@ -0,0 +1,2 @@\n+a\n+b\n', 'new')).toEqual([[1, 2]]);
    expect(shownRanges('Binary files a/x and b/x differ\n', 'new')).toEqual([]);
    expect(shownRanges('', 'new')).toEqual([]);
  });

  it('requires the whole range inside one hunk', () => {
    const r = shownRanges(patch, 'new');
    expect(isShown(r, 2, 5)).toBe(true);
    expect(isShown(r, 5, 6)).toBe(false);
    expect(isShown(r, 10, 10)).toBe(false);
    expect(isShown(r, 22, 22)).toBe(true);
  });
});
