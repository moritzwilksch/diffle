import { prepareFileTreeInput } from '@pierre/trees';
import { describe, expect, it } from 'vitest';
import {
  comparisonLabel,
  type ChangedFile,
  type CommentThread,
  type GithubMetadata,
  type Snapshot,
} from '../../src/shared/protocol.js';
import {
  anchorLabel,
  canJumpBack,
  canJumpForward,
  commitBody,
  compareTreeOrder,
  countViewed,
  currentPath,
  documentTitle,
  draftRange,
  imageSides,
  isCollapsed,
  isViewed,
  iterationPick,
  iterationStep,
  movedLabel,
  nextFileAfter,
  relativeTime,
  rangeStep,
  reuseThreads,
  viewedState,
} from '../../src/client/model.js';
import type { ReviewState } from '../../src/client/store.js';

describe('compareTreeOrder', () => {
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

describe('anchorLabel', () => {
  it('names a line, a range, a removed range, or the whole file', () => {
    const line = { kind: 'line', path: 'a.py', side: 'new', startLine: 3, endLine: 3, quoted: '' } as const;
    expect(anchorLabel(line)).toBe('L3');
    expect(anchorLabel({ ...line, endLine: 5 })).toBe('L3–5');
    expect(anchorLabel({ ...line, side: 'old' })).toBe('removed L3');
    expect(anchorLabel({ kind: 'file', path: 'a.py' })).toBe('whole file');
  });
});

describe('jumplist buttons', () => {
  const jumps = ['a.py', 'b.py', 'c.py'].map((path, i) => ({ path, side: 'new' as const, line: i + 1 }));
  const at = (jumpIndex: number, list = jumps, fileView: ReviewState['fileView'] = null) => {
    const state = { jumps: list, jumpIndex, fileView };
    return [canJumpBack(state), canJumpForward(state)];
  };

  it('opens back at older jumplist positions and forward at newer ones', () => {
    expect(at(0, [])).toEqual([false, false]);
    expect(at(jumps.length)).toEqual([true, false]);
    expect(at(1)).toEqual([true, true]);
    expect(at(0)).toEqual([false, true]);
  });

  it('opens back in a full-file view even with an empty jumplist', () => {
    const view = { path: 'a.py', external: false, item: null, from: { position: null, activePath: null } };
    expect(at(0, [], view)).toEqual([true, false]);
  });
});

describe('draftRange', () => {
  it('is the lines a line draft anchors to, and null for a file draft', () => {
    const selection = {
      id: 'file:a.py@0',
      range: { start: 8, side: 'additions', end: 3, endSide: 'additions' },
    } as const;
    expect(draftRange({ draft: { path: 'a.py', selection }, loaded: {} })).toEqual({
      side: 'new',
      startLine: 3,
      endLine: 8,
    });
    expect(draftRange({ draft: { path: 'a.py', selection: null }, loaded: {} })).toBeNull();
    expect(draftRange({ draft: null, loaded: {} })).toBeNull();
  });
});

describe('reuseThreads', () => {
  const thread = (id: string, over: Partial<CommentThread> = {}): CommentThread => ({
    id,
    anchor: { kind: 'line', path: 'a.py', side: 'new', startLine: 1, endLine: 1, quoted: 'x' },
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
  it('the current file is the cursor’s, else the whole-file view’s, else the first in tree order', () => {
    const changed = ['src/b.ts', 'src/a.ts'].map((path) => ({
      path,
      status: 'M' as const,
      additions: 1,
      deletions: 0,
      binary: false,
      blob: 'b',
      oldBlob: '',
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

describe('viewed state', () => {
  const file = (path: string, blob = 'b'): ChangedFile => ({
    path,
    status: 'M',
    additions: 1,
    deletions: 0,
    binary: false,
    blob,
    oldBlob: '',
    generated: false,
  });
  const config = { autoViewed: ['*.lock'], contextLines: 5, followRefs: 'off' as const, lspCommands: {} };

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

  it('derives restale from a viewed mark at an older blob and lets the current blob win', () => {
    const f = file('a.py', 'b2');
    const mark = (blob: string, viewed: boolean) => ({ path: 'a.py', blob, viewed });
    expect(viewedState({ viewed: [], config }, f)).toBe('unviewed');
    expect(viewedState({ viewed: [mark('b1', true)], config }, f)).toBe('restale');
    expect(viewedState({ viewed: [mark('b1', false)], config }, f)).toBe('unviewed');
    expect(viewedState({ viewed: [mark('b1', true), mark('b2', false)], config }, f)).toBe('unviewed');
    expect(viewedState({ viewed: [mark('b1', true), mark('b2', true)], config }, f)).toBe('viewed');
    expect(viewedState({ viewed: [], config }, file('x.lock'))).toBe('viewed');
  });

  it('collapses viewed and generated files by default, keeps a restale file open, and lets a toggle win', () => {
    const snapshot = { changed: [{ ...file('gen.py'), generated: true }, file('a.py', 'b2')] } as Snapshot;
    const state = (collapsed: Record<string, boolean>, blob = 'b2') => ({
      collapsed,
      viewed: [{ path: 'a.py', blob, viewed: true }],
      config,
      snapshot,
    });
    expect(isCollapsed(state({}), 'gen.py')).toBe(true);
    expect(isCollapsed(state({}), 'a.py')).toBe(true);
    expect(isCollapsed(state({}, 'b1'), 'a.py')).toBe(false);
    expect(isCollapsed(state({ 'gen.py': false, 'a.py': false }), 'gen.py')).toBe(false);
    expect(isCollapsed(state({ 'gen.py': false, 'a.py': false }), 'a.py')).toBe(false);
  });
});

describe('nextFileAfter', () => {
  const file = (path: string, blob = 'b'): ChangedFile => ({
    path,
    status: 'M',
    additions: 1,
    deletions: 0,
    binary: false,
    blob,
    oldBlob: '',
    generated: false,
  });
  const config = { autoViewed: ['*.lock'], contextLines: 5, followRefs: 'off' as const, lspCommands: {} };
  const snapshot = {
    changed: [file('c.ts', 'new'), file('yarn.lock'), file('a.ts'), file('b.ts'), file('d.ts')],
  } as Snapshot;

  it('finds the next unviewed file in tree order, counting a restale file as unviewed and skipping auto-viewed ones', () => {
    const viewed = [
      { path: 'b.ts', blob: 'b', viewed: true },
      { path: 'c.ts', blob: 'old', viewed: true },
    ];
    const unviewed = (f: ChangedFile) => !isViewed({ viewed, config }, f);
    expect(nextFileAfter(snapshot, 'a.ts', unviewed)?.path).toBe('c.ts');
    expect(nextFileAfter(snapshot, 'c.ts', unviewed)?.path).toBe('d.ts');
    expect(nextFileAfter(snapshot, 'd.ts', unviewed)).toBeNull();
    expect(nextFileAfter(snapshot, 'missing.ts', unviewed)).toBeNull();
  });
});

describe('documentTitle', () => {
  const snapshot = (mode: Partial<Snapshot['mode']>, root = '/home/me/rattler/'): Snapshot =>
    ({ root, mode }) as Snapshot;

  it('names the root directory', () => {
    expect(documentTitle(snapshot({}))).toBe('diffle: rattler');
  });

  it('names the pull request by its base repository and number, not the checkout directory', () => {
    const github = { pullRequest: { repository: 'conda/rattler', number: 12345 } } as GithubMetadata;
    expect(documentTitle(snapshot({}, '/tmp/diffle-pr-lTXVEf'), github)).toBe('diffle: conda/rattler #12345');
  });
});

describe('comparisonLabel', () => {
  it('shows branch paths from fetched PR refs without the session namespace', () => {
    expect(
      comparisonLabel({
        old: 'refs/diffle/session/42/base/main',
        new: 'refs/diffle/session/42/head/feature/nested',
        base: 'merge-base',
      }),
    ).toBe('main...feature/nested');
    expect(comparisonLabel({ old: 'HEAD', new: 'worktree', base: 'direct' })).toBe('HEAD..worktree');
    const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
    expect(comparisonLabel({ old: sha, new: sha, base: 'parent' })).toBe('a1b2c3d^!');
  });
});

describe('iterationPick', () => {
  it('compares a clicked row with the latest, and leaves a repeated pick alone', () => {
    expect(iterationPick(null, 4, 2, false)).toEqual({ from: 2, to: 4 });
    expect(iterationPick(null, 4, 2, true)).toEqual({ from: 2, to: 4 });
    expect(iterationPick(null, 4, 4, false)).toBeNull();
    expect(iterationPick({ from: 2, to: 4 }, 4, 2, false)).toBeNull();
    expect(iterationPick({ from: 2, to: 4 }, 4, 4, true)).toBeNull();
  });

  it('sets the lower number with a plain click and the higher with shift, in order when they cross', () => {
    expect(iterationPick({ from: 3, to: 9 }, 10, 5, false)).toEqual({ from: 5, to: 9 });
    expect(iterationPick({ from: 3, to: 9 }, 10, 5, true)).toEqual({ from: 3, to: 5 });
    expect(iterationPick({ from: 4, to: 10 }, 10, 2, false)).toEqual({ from: 2, to: 10 });
    expect(iterationPick({ from: 4, to: 10 }, 10, 2, true)).toEqual({ from: 2, to: 4 });
    expect(iterationPick({ from: 3, to: 9 }, 10, 10, false)).toEqual({ from: 9, to: 10 });
    expect(iterationPick({ from: 3, to: 9 }, 10, 10, true)).toEqual({ from: 3, to: 10 });
    expect(iterationPick({ from: 3, to: 9 }, 10, 9, false)).toBeNull();
  });
});

describe('iterationStep', () => {
  const list = [1, 2, 3, 4].map((n) => ({ n }));
  it('moves the lower end along the list, and the higher end with the shifted keys', () => {
    expect(iterationStep(list, { from: 2, to: 4 }, 'lower', -1)).toEqual({ from: 1, to: 4 });
    expect(iterationStep(list, { from: 2, to: 4 }, 'lower', 1)).toEqual({ from: 3, to: 4 });
    expect(iterationStep(list, { from: 1, to: 4 }, 'higher', -1)).toEqual({ from: 1, to: 3 });
    expect(iterationStep(list, { from: 1, to: 3 }, 'higher', 1)).toEqual({ from: 1, to: 4 });
  });

  it('starts from the latest without a span and stops at the edges', () => {
    expect(iterationStep(list, null, 'lower', -1)).toEqual({ from: 3, to: 4 });
    expect(iterationStep(list, null, 'lower', 1)).toBeNull();
    expect(iterationStep(list, { from: 1, to: 4 }, 'lower', -1)).toBeNull();
    expect(iterationStep(list, { from: 1, to: 4 }, 'higher', 1)).toBeNull();
    expect(iterationStep([], null, 'lower', -1)).toBeNull();
  });
});

describe('relativeTime', () => {
  it('rounds to the largest unit that elapsed and says "just now" under a minute', () => {
    const now = 1_700_000_000_000;
    expect(relativeTime(now - 20_000, now)).toBe('just now');
    expect(relativeTime(now - 90_000, now)).toBe('2 minutes ago');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 hours ago');
    expect(relativeTime(now - 86_400_000, now)).toBe('yesterday');
  });
});

describe('movedLabel', () => {
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const c = 'c'.repeat(40);
  const d = 'd'.repeat(40);
  const snap = (mode: Snapshot['mode']) =>
    ({ mode, commits: { list: [], total: 0, oldSha: a, newSha: b } }) as unknown as Snapshot;
  const refs = { old: 'main', new: 'refs/heads/feat', base: 'direct', live: 'refs', commentKey: 'k' } as const;

  it('names the end that moved by its ref, and the merge base as such', () => {
    expect(movedLabel(snap(refs), { version: 1, oldSha: a, newSha: c })).toBe('feat bbbbbbb → ccccccc');
    expect(movedLabel(snap(refs), { version: 1, oldSha: d, newSha: b })).toBe('main aaaaaaa → ddddddd');
    expect(movedLabel(snap({ ...refs, base: 'merge-base' }), { version: 1, oldSha: d, newSha: c })).toBe(
      'feat bbbbbbb → ccccccc, merge base aaaaaaa → ddddddd',
    );
  });

  it('describes the range a focused commit sits in, not the commit', () => {
    const focused = { old: b, new: b, base: 'parent', live: 'refs', commentKey: `commit:${b}`, within: refs } as const;
    expect(movedLabel(snap(focused), { version: 1, oldSha: a, newSha: c })).toBe('feat bbbbbbb → ccccccc');
  });
});

describe('imageSides', () => {
  const file = (status: ChangedFile['status']): ChangedFile => ({
    path: 'a.png',
    status,
    additions: 0,
    deletions: 0,
    binary: true,
    blob: '',
    oldBlob: '',
    generated: false,
  });

  it('shows the sides a changed image has, and the new side in the file view', () => {
    expect(imageSides('a.png', file('M'))).toBe('both');
    expect(imageSides('a.PNG', file('R'))).toBe('both');
    expect(imageSides('a.jpeg', file('A'))).toBe('new');
    expect(imageSides('a.gif', file('D'))).toBe('old');
    expect(imageSides('a.webp', undefined)).toBe('new');
  });

  it('leaves other binaries and text images to their banner and text diff', () => {
    expect(imageSides('a.bin', file('M'))).toBeNull();
    expect(imageSides('a.svg', file('M'))).toBeNull();
    expect(imageSides('png', file('M'))).toBeNull();
  });
});

describe('commitBody', () => {
  it('reflows hard-wrapped paragraphs but keeps list items and indented lines on their own', () => {
    const message = [
      'feat: add a box',
      '',
      'Adds a box at the top of the file list that shows the',
      'current commit and steps through the commits.',
      '',
      '- one item',
      '- another item that wraps',
      '  onto a second line',
      '',
      '    indented code',
      '',
    ].join('\n');
    expect(commitBody(message)).toEqual([
      'Adds a box at the top of the file list that shows the current commit and steps through the commits.',
      '- one item\n- another item that wraps\n  onto a second line',
      '    indented code',
    ]);
  });

  it('is empty for a subject alone', () => {
    expect(commitBody('fix: one line\n')).toEqual([]);
  });
});

describe('rangeStep', () => {
  const range = {
    old: 'main',
    new: 'feat',
    base: 'merge-base',
    live: 'refs',
    commentKey: 'range:main...feat',
  } as const;
  const commit = (sha: string) => ({ sha, short: sha.slice(0, 7), message: sha, author: 'a', email: 'a@a', date: 0 });
  const commits = {
    list: [commit('a'.repeat(40)), commit('b'.repeat(40))],
    total: 2,
    oldSha: '0'.repeat(40),
    newSha: 'b'.repeat(40),
  };
  const focused = (sha: string) => ({
    mode: { old: sha, new: sha, base: 'parent', live: 'refs', commentKey: `commit:${sha}`, within: range } as const,
    commits,
  });

  it('walks from the range to the newest commit, older to the oldest, and stops at either end', () => {
    expect(rangeStep({ mode: range, commits }, 1)).toBeUndefined();
    expect(rangeStep({ mode: range, commits }, -1)).toBe('b'.repeat(40));
    expect(rangeStep(focused('b'.repeat(40)), 1)).toBeNull();
    expect(rangeStep(focused('b'.repeat(40)), -1)).toBe('a'.repeat(40));
    expect(rangeStep(focused('a'.repeat(40)), -1)).toBeUndefined();
  });

  it('stops at the uncommitted changes between the newest commit and a range that ends at the worktree', () => {
    const toWorktree = { ...range, new: 'worktree', live: 'worktree' } as const;
    const within = (sha: string) => ({ ...focused(sha), mode: { ...focused(sha).mode, within: toWorktree } });
    const uncommitted = {
      mode: {
        old: 'HEAD',
        new: 'worktree',
        base: 'direct',
        live: 'worktree',
        commentKey: 'working',
        within: toWorktree,
      },
      commits,
    } as const;
    expect(rangeStep({ mode: toWorktree, commits }, -1)).toBe('worktree');
    expect(rangeStep(uncommitted, -1)).toBe('b'.repeat(40));
    expect(rangeStep(uncommitted, 1)).toBeNull();
    expect(rangeStep(within('b'.repeat(40)), 1)).toBe('worktree');
    // Without a commit, the uncommitted changes are the whole range.
    expect(rangeStep({ mode: toWorktree, commits: { ...commits, list: [], total: 0 } }, -1)).toBeUndefined();
  });

  it("steps through an interdiff's pairs with something to show, skipping identical and dropped ones", () => {
    const it = (n: number) => ({
      old: '0'.repeat(40),
      new: 'b'.repeat(40),
      oldSha: '0'.repeat(40),
      newSha: 'b'.repeat(40),
      iteration: n,
    });
    const pairs = [
      { old: commit('1'.repeat(40)), new: commit('a'.repeat(40)), status: 'identical' as const },
      { old: commit('2'.repeat(40)), new: null, status: 'dropped' as const },
      { old: commit('3'.repeat(40)), new: commit('b'.repeat(40)), status: 'changed' as const },
      { old: null, new: commit('c'.repeat(40)), status: 'added' as const },
    ];
    const interdiff = { from: it(1), to: it(2), conflicts: [], pairs };
    const whole = {
      mode: {
        old: 't',
        new: 'b'.repeat(40),
        base: 'direct',
        live: 'refs',
        commentKey: 'i',
        within: range,
        interdiff,
      } as const,
      commits,
    };
    const pair = (sha: string) => ({
      ...whole,
      mode: { ...whole.mode, new: sha, pair: { old: null, new: sha, conflicts: [] } },
    });
    expect(rangeStep(whole, 1)).toBeUndefined();
    expect(rangeStep(whole, -1)).toBe('c'.repeat(40));
    expect(rangeStep(pair('c'.repeat(40)), -1)).toBe('b'.repeat(40));
    expect(rangeStep(pair('c'.repeat(40)), 1)).toBeNull();
    expect(rangeStep(pair('b'.repeat(40)), -1)).toBeUndefined();
  });

  it('steps a commit the range no longer lists newer to the range, and a lone commit nowhere', () => {
    expect(rangeStep(focused('c'.repeat(40)), 1)).toBeNull();
    expect(rangeStep(focused('c'.repeat(40)), -1)).toBeUndefined();
    const { within: _, ...lone } = focused('a'.repeat(40)).mode;
    expect(rangeStep({ mode: lone, commits }, 1)).toBeUndefined();
  });
});
