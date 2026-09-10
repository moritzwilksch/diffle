import { prepareFileTreeInput } from '@pierre/trees';
import { describe, expect, it } from 'vitest';
import type { ChangedFile, CommentThread, Snapshot } from '../../src/shared/protocol.js';
import {
  canExportToGithub,
  compareTreeOrder,
  countViewed,
  currentPath,
  documentTitle,
  nextSearchScope,
  orderedPaths,
  reuseThreads,
  widenSearchScope,
} from '../../src/client/model.js';

describe('orderedPaths', () => {
  it('follows the file tree: folders first, then case-insensitive natural order', () => {
    const paths = [
      'src/App.tsx',
      'src/api.ts',
      'README.md',
      'src/review/order.ts',
      '.github/ci.yml',
      'src/.eslintrc',
      'a/b/c.ts',
      'a/b.ts',
    ];
    const changed = paths.map((path) => ({
      path,
      status: 'M' as const,
      additions: 1,
      deletions: 0,
      binary: false,
      blob: 'b',
      generated: false,
    }));
    const snapshot = { changed, tree: [...paths].sort() } as unknown as Snapshot;
    expect(orderedPaths(snapshot)).toEqual([
      '.github/ci.yml',
      'a/b/c.ts',
      'a/b.ts',
      'src/review/order.ts',
      'src/.eslintrc',
      'src/api.ts',
      'src/App.tsx',
      'README.md',
    ]);
  });

  it('is a total order', () => {
    expect(compareTreeOrder('x/y.ts', 'x/y.ts')).toBe(0);
    expect(compareTreeOrder('a.ts', 'B.ts')).toBeLessThan(0);
    expect(compareTreeOrder('B.ts', 'a.ts')).toBeGreaterThan(0);
  });

  it('matches the tree library on the cases where locale order and dot-first rules disagree with it', () => {
    const paths = [
      'b/a_x.py',
      'b/a-x.py',
      'file10.py',
      'file2.py',
      'File2.py',
      '.github/ci.yml',
      '_secrets.py',
      'secrets.enc.yaml',
      'B.md',
      'a.md',
      'x/y/z.ts',
      'x/y.ts',
      'v1.2.3/a',
      'v1.10.0/a',
    ];
    const theirs = prepareFileTreeInput(paths).paths;
    expect([...paths].sort(compareTreeOrder)).toEqual(theirs);
  });

  it('matches the tree library on generated path sets', () => {
    // Deterministic LCG so a failure is reproducible.
    let seed = 42;
    const rand = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    const segs = [
      'a',
      'B',
      'a_b',
      'a-b',
      'a.b',
      '.dot',
      'x1',
      'x10',
      'x2',
      'X02',
      'z',
      'ä',
      '_u',
      'e2e',
      'E2E',
      'main',
      'Main',
    ];
    for (let round = 0; round < 200; round++) {
      const set = new Set<string>();
      const count = 2 + rand(12);
      for (let i = 0; i < count; i++) {
        const depth = 1 + rand(3);
        set.add(Array.from({ length: depth }, () => segs[rand(segs.length)]!).join('/'));
      }
      const paths = [...set];
      expect([...paths].sort(compareTreeOrder), paths.join(' ')).toEqual(prepareFileTreeInput(paths).paths);
    }
  });
});

describe('reuseThreads', () => {
  const thread = (id: string, over: Partial<CommentThread> = {}): CommentThread => ({
    id,
    anchor: { path: 'a.py', side: 'new', startLine: 1, endLine: 1, quoted: 'x' },
    messages: [{ id: `${id}-m`, body: 'b', createdAt: 1, updatedAt: 1 }],
    resolved: false,
    stale: false,
    ...over,
  });

  it('keeps the previous objects for unchanged threads and the list itself when nothing changed', () => {
    const prev = [thread('a'), thread('b')];
    expect(reuseThreads(prev, [thread('a'), thread('b')])).toBe(prev);
    const next = reuseThreads(prev, [thread('a'), thread('b', { stale: true })]);
    expect(next).not.toBe(prev);
    expect(next[0]).toBe(prev[0]);
    expect(next[1]).not.toBe(prev[1]);
    expect(next[1]?.stale).toBe(true);
  });

  it('follows deletions and reorders', () => {
    const prev = [thread('a'), thread('b')];
    expect(reuseThreads(prev, [thread('b')])).toEqual([prev[1]]);
    expect(reuseThreads(prev, [thread('b'), thread('a')]).map((t) => t.id)).toEqual(['b', 'a']);
  });
});

describe('search scope', () => {
  it('cycles file → diff → repo → file', () => {
    expect(nextSearchScope('file')).toBe('diff');
    expect(nextSearchScope('diff')).toBe('repo');
    expect(nextSearchScope('repo')).toBe('file');
  });

  it('g/ widens a file search to the diff and keeps a repo choice', () => {
    expect(widenSearchScope('file')).toBe('diff');
    expect(widenSearchScope('diff')).toBe('diff');
    expect(widenSearchScope('repo')).toBe('repo');
  });

  it('the current file is the cursor’s, else the whole-file view’s, else the first in tree order', () => {
    const changed = ['src/b.ts', 'src/a.ts'].map((path) => ({
      path,
      status: 'M' as const,
      additions: 1,
      deletions: 0,
      binary: false,
      blob: 'b',
      generated: false,
    }));
    const snapshot = { changed, tree: ['src/a.ts', 'src/b.ts', 'src/c.ts'] } as unknown as Snapshot;
    const view = { path: 'src/c.ts', external: false, item: null, from: { position: null, activePath: null } };
    expect(currentPath({ snapshot, activePath: 'src/b.ts', fileView: view })).toBe('src/b.ts');
    expect(currentPath({ snapshot, activePath: null, fileView: view })).toBe('src/c.ts');
    expect(currentPath({ snapshot, activePath: null, fileView: null })).toBe('src/a.ts');
    expect(currentPath({ snapshot: null, activePath: null, fileView: null })).toBeNull();
  });
});

describe('countViewed', () => {
  const file = (path: string, blob = 'b'): ChangedFile => ({
    path,
    status: 'M',
    additions: 1,
    deletions: 0,
    binary: false,
    blob,
    generated: false,
  });
  const config = { autoViewed: ['*.lock'], contextLines: 5, lspCommands: {} };

  it('counts explicit marks at the current blob and auto-viewed files; a stale mark is not viewed', () => {
    const changed = [file('a.ts'), file('b.ts'), file('c.ts', 'new'), file('yarn.lock')];
    const viewed = [
      { path: 'a.ts', blob: 'b', viewed: true },
      { path: 'b.ts', blob: 'b', viewed: false },
      { path: 'c.ts', blob: 'old', viewed: true },
    ];
    expect(countViewed({ viewed, config }, changed)).toBe(2);
    expect(countViewed({ viewed: [], config }, changed)).toBe(1);
    expect(countViewed({ viewed: [{ path: 'yarn.lock', blob: 'b', viewed: false }], config }, changed)).toBe(0);
    expect(countViewed({ viewed, config }, [])).toBe(0);
  });
});

describe('canExportToGithub', () => {
  const snap = (newSha: Snapshot['newSha'], headSha: string): Snapshot => ({ newSha, headSha }) as unknown as Snapshot;

  it('allows a commit that is the checked-out HEAD', () => {
    expect(canExportToGithub(snap('a'.repeat(40), 'a'.repeat(40)))).toBe(true);
  });

  it('refuses the worktree and a new side that is not HEAD', () => {
    expect(canExportToGithub(snap('worktree', 'a'.repeat(40)))).toBe(false);
    expect(canExportToGithub(snap('b'.repeat(40), 'a'.repeat(40)))).toBe(false);
  });

  it('refuses before the first snapshot', () => {
    expect(canExportToGithub(null)).toBe(false);
  });
});

describe('documentTitle', () => {
  const snapshot = (mode: Partial<Snapshot['mode']>, root = '/home/me/rattler/'): Snapshot =>
    ({ root, mode: { kind: 'working', ...mode } }) as Snapshot;

  it('names the root directory', () => {
    expect(documentTitle(snapshot({}))).toBe('diffle: rattler');
  });

  it('names the pull request by its base repository and number, not the checkout directory', () => {
    const mode = { kind: 'pr' as const, pullRequest: { repository: 'conda/rattler', number: 12345 } };
    expect(documentTitle(snapshot(mode, '/tmp/diffle-pr-lTXVEf'))).toBe('diffle: conda/rattler #12345');
  });

  it('falls back before the first snapshot', () => {
    expect(documentTitle(null)).toBe('diffle');
  });
});
