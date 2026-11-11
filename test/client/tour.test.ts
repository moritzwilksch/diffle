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
  it('reads the title, each h2 as a step with its h3s, and the diffs each section holds', () => {
    const tour = readTour(`
      <h1>Kinds</h1>
      <p>Intro <diffle-diff path="a.py" lines="1"></diffle-diff></p>
      <h2>Entries</h2>
      <diffle-card id="c" title="Kind"><diffle-diff path="a.py" lines="3-4"></diffle-diff></diffle-card>
      <h3>Parsing</h3>
      <diffle-diff path="b.py" side="old" lines="7"></diffle-diff>
      <h2>Refunds</h2>
      <p>Prose only.</p>`);
    expect(tour.title).toBe('Kinds');
    expect(tour.sections.map((s) => [s.title, s.subsections.map((h) => h.title), s.ranges])).toEqual([
      [
        'Entries',
        ['Parsing'],
        [
          { path: 'a.py', side: 'new', start: 3, end: 4 },
          { path: 'b.py', side: 'old', start: 7, end: 7 },
        ],
      ],
      ['Refunds', [], []],
    ]);
  });
});
