// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { readTour } from '@/client/tour/document.js';
import { excerpt } from '@/client/tour/excerpt.js';

const PATCH = `diff --git a/app.py b/app.py
--- a/app.py
+++ b/app.py
@@ -2,3 +2,4 @@ import os
 a
-b
+B
+C
 d
`;
// app.py after the change; before it read: import os, a, b, d, e, f.
const NEW = 'import os\na\nB\nC\nd\ne\nf\n';
const OLD = 'import os\na\nb\nd\ne\nf\n';

const body = (patch: string | null) => patch?.split('\n').slice(3).join('\n');

describe('excerpt', () => {
  it('shows the lines a range names, numbered as in the file, with the deletions at their edge', () => {
    expect(body(excerpt({ path: 'app.py', side: 'new', start: 3, end: 4 }, NEW, PATCH))).toBe(
      '@@ -3,1 +3,2 @@\n-b\n+B\n+C\n',
    );
    expect(body(excerpt({ path: 'app.py', side: 'new', start: 2, end: 6 }, NEW, PATCH))).toBe(
      '@@ -2,4 +2,5 @@\n a\n-b\n+B\n+C\n d\n e\n',
    );
  });

  it('counts the old side on its own numbers, and lines past every hunk from the file', () => {
    expect(body(excerpt({ path: 'app.py', side: 'old', start: 3, end: 3 }, OLD, PATCH))).toBe(
      '@@ -3,1 +3,2 @@\n-b\n+B\n+C\n',
    );
    expect(body(excerpt({ path: 'app.py', side: 'new', start: 7, end: 7 }, NEW, PATCH))).toBe('@@ -6,1 +7,1 @@\n f\n');
  });

  it('shows an unchanged file as its lines, and nothing for lines past its end', () => {
    expect(body(excerpt({ path: 'app.py', side: 'new', start: 1, end: 2 }, OLD, ''))).toBe(
      '@@ -1,2 +1,2 @@\n import os\n a\n',
    );
    expect(excerpt({ path: 'app.py', side: 'new', start: 6, end: 9 }, NEW, PATCH)).toBeNull();
  });
});

describe('readTour', () => {
  it('reads cards, groups, arrows and the walk, leaving out what the catalog does not allow', () => {
    const tour = readTour(`
      <diffle-card id="b" step="2" title="Second"><diffle-diff path="a.py" lines="3-4"></diffle-diff></diffle-card>
      <diffle-group title="Core">
        <diffle-card id="a" step="1" title="First"></diffle-card>
        <diffle-card id="c" title="Context"></diffle-card>
      </diffle-group>
      <diffle-card id="bad" step="x" title="Dropped"></diffle-card>
      <diffle-edge from="a" to="b" label="calls"></diffle-edge>
      <diffle-edge from="a" to="ghost"></diffle-edge>`);
    expect(tour.cards.map((c) => [c.id, c.step, c.group])).toEqual([
      ['b', 2, null],
      ['a', 1, 0],
      ['c', null, 0],
    ]);
    expect(tour.groups).toEqual(['Core']);
    expect(tour.steps.map((c) => c.id)).toEqual(['a', 'b']);
    expect(tour.arrows).toEqual([{ from: 'a', to: 'b', label: 'calls' }]);
    expect(tour.cards[0]!.ranges).toEqual([{ path: 'a.py', side: 'new', start: 3, end: 4 }]);
  });
});
