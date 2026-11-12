// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { readTour } from '@/client/tour/document.js';
import { excerpt } from '@/client/tour/excerpt.js';
import { selectionTarget, textRange } from '@/client/tour/anchor.js';
import { freeSpot, placeCards } from '@/client/tour/margin/cards.js';

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

describe('placeCards', () => {
  const items = [
    { id: 'a', want: 100, height: 50 },
    { id: 'b', want: 110, height: 50 },
    { id: 'c', want: 300, height: 50 },
  ];

  it('keeps each card at its anchor or below the one above it', () => {
    expect([...placeCards(items, null)]).toEqual([
      ['a', 100],
      ['b', 158],
      ['c', 300],
    ]);
  });

  it('holds the active card at its anchor and pushes the ones above it up', () => {
    expect([...placeCards(items, 'b')]).toEqual([
      ['a', 52],
      ['b', 110],
      ['c', 300],
    ]);
  });
});

describe('freeSpot', () => {
  const cards = [
    { top: 100, height: 80 },
    { top: 188, height: 40 },
  ];

  it('stays at its anchor where the margin is free', () => {
    expect(freeSpot(20, 28, cards)).toBe(20);
  });

  it('takes the free room nearest its anchor, never over a card', () => {
    // At 110 it would cover the first card; above it (64) is nearer than below the second (236).
    expect(freeSpot(110, 28, cards)).toBe(64);
    expect(freeSpot(200, 28, cards)).toBe(236);
  });
});

describe('a selection in the tour', () => {
  const article = () => {
    document.body.innerHTML = `<article>
      <p data-node="3">It <b>calls</b> fetch again, and
        again.</p>
      <figure data-node="4" data-opaque=""><p>again</p></figure>
    </article>`;
    return document.querySelector('article')!;
  };
  const selectText = (el: Element, from: number, to: number) => {
    const text = el.firstChild!.nextSibling!.nextSibling as Text;
    const range = document.createRange();
    range.setStart(text, from);
    range.setEnd(text, to);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
  };

  it('names the element and which match of the words, whitespace ignored, and finds them again', () => {
    const root = article();
    // "and\n        again." in " fetch again, and\n        again.".
    selectText(root.querySelector('p')!, 14, 32);

    const found = selectionTarget(document.getSelection(), root);

    expect(found).toEqual({ node: [3], target: { on: 'text', quoted: 'and again.', occurrence: 0 } });
    const again = { node: [3], target: { on: 'text' as const, quoted: 'again', occurrence: 1 } };
    expect(textRange(root, again)?.toString()).toBe('again');
    expect(textRange(root, { ...again, target: { ...again.target, occurrence: 2 } })).toBeNull();
  });

  it('refuses words inside a diff or a drawing', () => {
    const root = article();
    const inner = root.querySelector('figure p')!.firstChild as Text;
    const range = document.createRange();
    range.setStart(inner, 0);
    range.setEnd(inner, 5);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);

    expect(selectionTarget(document.getSelection(), root)).toEqual({
      refused: 'Comment on a diff, code or a diagram as a whole',
    });
  });
});
