import type { FileTreeDirectoryHandle } from '@pierre/trees';
import { FileTree } from '@pierre/trees';
import { describe, expect, it } from 'vitest';
import type { ReviewState } from '../../src/client/store.js';
import type { ChangedFile } from '../../src/shared/protocol.js';
import { DEFAULT_USER_CONFIG } from '../../src/shared/protocol.js';
import type { SyncKeys } from '../../src/client/tree/sync.js';
import { decorationKey, directoriesOf, expandedAfterReset, statusKey, syncStep, toGitStatus } from '../../src/client/tree/sync.js';

function file(path: string, extra: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path,
    status: 'M',
    additions: 1,
    deletions: 0,
    binary: false,
    blob: 'b1',
    generated: false,
    ...extra,
  };
}

// Mirrors FileTreePane: explicit expansion so `initialExpandedPaths` is honored on reset.
function tree(paths: string[]) {
  return new FileTree({
    paths,
    initialExpansion: 'closed',
    initialExpandedPaths: directoriesOf(paths),
  });
}

function dir(t: FileTree, path: string): FileTreeDirectoryHandle {
  const item = t.getItem(path);
  if (!item?.isDirectory()) throw new Error(`not a directory: ${path}`);
  return item as FileTreeDirectoryHandle;
}

describe('directoriesOf', () => {
  it('lists every ancestor once, without trailing slash', () => {
    expect(directoriesOf(['a/b/c.ts', 'a/d.ts', 'e.ts', 'a/b/f.ts'])).toEqual(['a', 'a/b']);
  });
});

describe('expandedAfterReset', () => {
  it('opens every folder on first build', () => {
    const t = tree(['a/b/c.ts', 'a/d.ts', 'e/f.ts']);
    expect(dir(t, 'a/b').isExpanded()).toBe(true);
    expect(t.getVisibleCount()).toBe(6);
  });

  it('keeps collapsed folders collapsed across a reset and opens new ones', () => {
    const t = tree(['a/b/c.ts', 'a/d.ts', 'e/f.ts']);
    dir(t, 'a/b').collapse();
    dir(t, 'e').collapse();
    const next = ['a/b/c.ts', 'a/d.ts', 'e/f.ts', 'e/g.ts', 'n/m.ts'];
    const expanded = expandedAfterReset(t, next);
    expect(expanded).toEqual(['a', 'n']);
    t.resetPaths(next, { initialExpandedPaths: expanded });
    expect(dir(t, 'a/b').isExpanded()).toBe(false);
    expect(dir(t, 'e').isExpanded()).toBe(false);
    expect(dir(t, 'n').isExpanded()).toBe(true);
    expect(t.getVisibleRows(0, t.getVisibleCount()).map((r) => r.path)).toEqual(['a/', 'a/b/', 'a/d.ts', 'e/', 'n/', 'n/m.ts']);
  });

  it('remembers folders hidden under a collapsed parent', () => {
    const t = tree(['a/b/c.ts', 'a/d.ts']);
    dir(t, 'a/b').collapse();
    dir(t, 'a').collapse();
    t.resetPaths(['a/b/c.ts', 'a/d.ts', 'a/x.ts'], {
      initialExpandedPaths: expandedAfterReset(t, ['a/b/c.ts', 'a/d.ts', 'a/x.ts']),
    });
    dir(t, 'a').expand();
    expect(dir(t, 'a/b').isExpanded()).toBe(false);
  });
});

describe('row keys', () => {
  const state = { viewed: [], config: DEFAULT_USER_CONFIG };

  it('statusKey hashes the mapped lane, so it moves exactly when setGitStatus would redraw', () => {
    // The tree folds M/T/U into 'modified' and R/C into 'renamed'; a key over the raw status
    // would take the status branch for M -> T and `setGitStatus` would no-op on its own signature.
    const m = [file('x.ts')];
    const t = [file('x.ts', { status: 'T' })];
    expect(statusKey(m)).toBe(statusKey(t));
    expect(statusKey([file('x.ts', { status: 'R' })])).toBe(statusKey([file('x.ts', { status: 'C' })]));
    expect(statusKey(m)).not.toBe(statusKey([file('x.ts', { status: 'A' })]));
    expect(m.map(toGitStatus)).toEqual(t.map(toGitStatus));
  });

  it('statusKey ignores counts and viewed marks', () => {
    const a = [file('x.ts'), file('y.ts', { status: 'A' })];
    const b = [file('x.ts', { additions: 9 }), file('y.ts', { status: 'A' })];
    expect(statusKey(a)).toBe(statusKey(b));
    expect(statusKey(a)).not.toBe(statusKey([file('x.ts'), file('y.ts', { status: 'D' })]));
  });

  it('decorationKey is stable for fresh but equal viewed and config objects', () => {
    const changed = [file('x.ts'), file('y.lock')];
    const k1 = decorationKey(
      {
        viewed: [{ path: 'x.ts', blob: 'b1', viewed: true }],
        config: { ...DEFAULT_USER_CONFIG },
      },
      changed,
    );
    const k2 = decorationKey(
      {
        viewed: [{ path: 'x.ts', blob: 'b1', viewed: true }],
        config: { ...DEFAULT_USER_CONFIG, contextLines: 99 },
      },
      changed,
    );
    expect(k1).toBe(k2);
  });

  it('decorationKey changes with marks, auto-viewed globs and counts', () => {
    const changed = [file('x.ts'), file('y.lock')];
    const base = decorationKey(state, changed);
    expect(decorationKey({ ...state, viewed: [{ path: 'x.ts', blob: 'b1', viewed: true }] }, changed)).not.toBe(base);
    expect(decorationKey({ ...state, config: { ...DEFAULT_USER_CONFIG, autoViewed: ['*.lock'] } }, changed)).not.toBe(base);
    expect(decorationKey(state, [file('x.ts', { deletions: 3 }), file('y.lock')])).not.toBe(base);
  });
});

describe('syncStep', () => {
  const state: Pick<ReviewState, 'viewed' | 'config'> = { viewed: [], config: DEFAULT_USER_CONFIG };
  const keysOf = (changed: ChangedFile[], s = state): SyncKeys => ({
    paths: changed.map((f) => f.path).join('\n'),
    status: statusKey(changed),
    decoration: decorationKey(s, changed),
  });

  it('does nothing before the first snapshot and for an equal one built from fresh arrays', () => {
    const a = keysOf([file('a/x.ts'), file('a/y.ts')]);
    expect(syncStep(null, a)).toBe('none');
    // Fable #13: every save yields new `paths`/`gitStatus` arrays; equal content must not reset.
    expect(syncStep(a, keysOf([file('a/x.ts'), file('a/y.ts')]))).toBe('none');
  });

  it('resets only when the path list changes', () => {
    const a = keysOf([file('a/x.ts')]);
    expect(syncStep(a, keysOf([file('a/x.ts'), file('a/y.ts')]))).toBe('reset');
    expect(syncStep(a, keysOf([file('a/x.ts', { status: 'A' })]))).toBe('status');
  });

  it('takes the decoration branch for M -> T with a count change', () => {
    const a = keysOf([file('x.ts')]);
    // Same lane after mapping, so `setGitStatus` would draw nothing; the counts still need a redraw.
    expect(syncStep(a, keysOf([file('x.ts', { status: 'T', additions: 5 })]))).toBe('decoration');
  });

  it('redraws decorations on a viewed mark and stays quiet on unrelated config', () => {
    const changed = [file('x.ts')];
    const a = keysOf(changed);
    expect(syncStep(a, keysOf(changed, { ...state, viewed: [{ path: 'x.ts', blob: 'b1', viewed: true }] }))).toBe('decoration');
    expect(syncStep(a, keysOf(changed, { ...state, config: { ...DEFAULT_USER_CONFIG, contextLines: 42 } }))).toBe('none');
  });
});
