import { parsePatchFiles } from '@pierre/diffs';
import { describe, expect, it } from 'vitest';
import { cursorFromSelection, diffRows, step, type NavItem } from '../../src/client/keyboard/nav.js';

const patch = `diff --git a/f.txt b/f.txt
--- a/f.txt
+++ b/f.txt
@@ -10,3 +10,3 @@
 ten
-eleven
+ELEVEN
 twelve
@@ -30,3 +30,3 @@
 thirty
-thirty-one
+THIRTY-ONE
 thirty-two
`;
const fileDiff = parsePatchFiles(patch, 'k')[0]!.files[0]!;

describe('diffRows with revealed context', () => {
  it('walks lines the viewer expanded instead of skipping to the next hunk', () => {
    const plain = diffRows(fileDiff);
    expect(plain.map((r) => `${r.side[0]}${r.line}`)).toEqual(['a10', 'd11', 'a11', 'a12', 'a30', 'd31', 'a31', 'a32']);

    // A jump into collapsed context revealed lines 5–12 (overlapping the first hunk) and 20–22.
    const rows = diffRows(fileDiff, [
      [5, 12],
      [20, 22],
    ]);
    expect(rows.map((r) => `${r.side[0]}${r.line}`)).toEqual(['a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'd11', 'a11', 'a12', 'a20', 'a21', 'a22', 'a30', 'd31', 'a31', 'a32']);
    expect(rows.filter((r) => r.hunkStart).map((r) => r.line)).toEqual([11, 31]);

    const nav: NavItem[] = [{ id: 'diff:f.txt@0', path: 'f.txt', collapsed: false, rows }];
    const cur = cursorFromSelection(nav, { id: nav[0]!.id, range: { start: 21, side: 'additions', end: 21, endSide: 'additions' } })!;
    expect(rows[cur.rowIndex]!.line).toBe(21);
    expect(rows[step(nav, cur, 1)!.rowIndex]!.line).toBe(22);
    expect(rows[step(nav, cur, -1)!.rowIndex]!.line).toBe(20);
  });

  it('stops once per change block, on the new side unless the block only deletes', () => {
    const twoBlocks = `diff --git a/g.txt b/g.txt
--- a/g.txt
+++ b/g.txt
@@ -1,7 +1,7 @@
 one
-two
+TWO
 three
 four
-five
+FIVE
+FIVE-B
-six
 seven
`;
    const rows = diffRows(parsePatchFiles(twoBlocks, 'k2')[0]!.files[0]!);
    expect(rows.filter((r) => r.hunkStart).map((r) => `${r.side[0]}${r.line}`)).toEqual(['a2', 'a5']);
    const pureDeletion = `diff --git a/h.txt b/h.txt
--- a/h.txt
+++ b/h.txt
@@ -1,3 +1,2 @@
 one
-two
 three
`;
    const del = diffRows(parsePatchFiles(pureDeletion, 'k3')[0]!.files[0]!);
    expect(del.filter((r) => r.hunkStart).map((r) => `${r.side[0]}${r.line}`)).toEqual(['d2']);
  });

  it('split view walks one visual line per row: a paired deletion folds into its addition', () => {
    const patch = `diff --git a/s.txt b/s.txt
--- a/s.txt
+++ b/s.txt
@@ -1,4 +1,3 @@
 one
-two
-three
+TWO
 four
`;
    const fd = parsePatchFiles(patch, 'k4')[0]!.files[0]!;
    expect(diffRows(fd, [], 'unified').map((r) => `${r.side[0]}${r.line}`)).toEqual(['a1', 'd2', 'd3', 'a2', 'a3']);
    expect(diffRows(fd, [], 'split').map((r) => `${r.side[0]}${r.line}`)).toEqual(['a1', 'a2', 'd3', 'a3']);
  });

  it('puts lines revealed past the last hunk at the end', () => {
    const rows = diffRows(fileDiff, [[33, 34]]);
    expect(rows.slice(-3).map((r) => r.line)).toEqual([32, 33, 34]);
  });
});
