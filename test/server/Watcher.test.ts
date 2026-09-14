import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { metaPaths, type WatchTarget } from '../../src/server/Watcher.js';

describe('metaPaths', () => {
  const gitDir = join('/repo', '.git');
  const refs = [join(gitDir, 'HEAD'), join(gitDir, 'refs'), join(gitDir, 'packed-refs')];
  const worktree = (gitDir: string, commonDir: string): WatchTarget => ({
    kind: 'worktree',
    root: '/repo',
    gitDir,
    commonDir,
    ignored: () => new Set(),
  });

  it('polls HEAD and the refs in refs mode and adds the index in worktree mode', () => {
    expect(metaPaths({ kind: 'refs', gitDir, commonDir: gitDir })).toEqual(refs);
    expect(metaPaths(worktree(gitDir, gitDir))).toEqual([...refs, join(gitDir, 'index')]);
  });

  it('watches a linked worktree through its own HEAD and index and the shared refs', () => {
    const linked = join(gitDir, 'worktrees', 'wt');
    expect(metaPaths(worktree(linked, gitDir))).toEqual([join(linked, 'HEAD'), ...refs, join(linked, 'index')]);
  });
});
