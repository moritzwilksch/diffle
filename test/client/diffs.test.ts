import { parsePatchFiles } from '@pierre/diffs';
import { describe, expect, it } from 'vitest';
import { PARSE } from '@/client/diffs.js';

// A body wrapped in a loop: four lines out, eight in, three of them alike. Paired by similarity,
// the block would split into three, the deletions shown between the additions.
const patch = `diff --git a/f.py b/f.py
--- a/f.py
+++ b/f.py
@@ -1,6 +1,10 @@
 def run(items):
-    result = compute(item)
-    store(result)
-    notify(result)
-    return result
+    for item in items:
+        if skip(item):
+            continue
+        result = compute(item)
+        store(result)
+        notify(result)
+    cleanup()
+    return result
 # end
`;

describe('diff parsing', () => {
  it("keeps an uneven change block whole, in git's order", () => {
    const hunk = parsePatchFiles(patch, { ...PARSE, cacheKeyPrefix: 'git' })[0]!.files[0]!.hunks[0]!;
    const blocks = hunk.hunkContent.filter((c) => c.type === 'change').map((c) => [c.deletions, c.additions]);
    expect(blocks).toEqual([[4, 8]]);
  });
});
