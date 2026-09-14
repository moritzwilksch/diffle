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
    expect(shownRanges(patch, 'old')).toEqual([
      [1, 4],
      [20, 20],
    ]);
    expect(shownRanges(patch, 'new')).toEqual([
      [1, 5],
      [21, 22],
    ]);
  });

  it('shows nothing for an empty side, a binary patch, or no patch', () => {
    expect(shownRanges('@@ -0,0 +1,2 @@\n+a\n+b\n', 'old')).toEqual([]);
    expect(shownRanges('@@ -0,0 +1,2 @@\n+a\n+b\n', 'new')).toEqual([[1, 2]]);
    expect(shownRanges('Binary files a/x and b/x differ\n', 'new')).toEqual([]);
    expect(shownRanges('', 'new')).toEqual([]);
  });

  it('narrows each hunk to the lines within `context` of a change, as a tighter diff would show them', () => {
    // `b` is added at new line 2: one context line reaches 1 and 3, the hunk's 4–5 stay out.
    expect(shownRanges(patch, 'new', 1)).toEqual([
      [1, 3],
      [21, 22],
    ]);
    // On the old side the insertion is a gap after line 1: context on both sides of it.
    expect(shownRanges(patch, 'old', 1)).toEqual([
      [1, 2],
      [20, 20],
    ]);
    // Wide context merged two changes into one hunk; a narrower one splits them again.
    const wide = ['@@ -1,10 +1,10 @@', ' a', '-b', '+B', ' c', ' d', ' e', ' f', ' g', ' h', '-i', '+I', ' j', ''].join(
      '\n',
    );
    expect(shownRanges(wide, 'new', 2)).toEqual([
      [1, 4],
      [7, 10],
    ]);
    expect(shownRanges(wide, 'new', 3)).toEqual([[1, 10]]);
    // Never wider than the hunk: a patch with less context than asked keeps its spans.
    expect(shownRanges(wide, 'new', 50)).toEqual([[1, 10]]);
    expect(shownRanges('@@ -1,2 +0,0 @@\n-a\n-b\n', 'new', 3)).toEqual([]);
    expect(shownRanges('@@ -0,0 +1,2 @@\n+a\n+b\n\\ No newline at end of file\n', 'new', 3)).toEqual([[1, 2]]);
  });

  it('requires the whole range inside one hunk', () => {
    const r = shownRanges(patch, 'new');
    expect(isShown(r, 2, 5)).toBe(true);
    expect(isShown(r, 5, 6)).toBe(false);
    expect(isShown(r, 10, 10)).toBe(false);
    expect(isShown(r, 22, 22)).toBe(true);
  });
});
