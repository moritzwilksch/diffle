import { describe, expect, it } from 'vitest';
import { permalink } from '@/client/review/permalink.js';
import type { Published, Snapshot } from '@/shared/protocol.js';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const snapshot = {
  version: 3,
  oldSha: OLD,
  newSha: NEW,
  changed: [{ path: 'src/new name.ts', oldPath: 'src/old#name.ts', status: 'R' }],
} as unknown as Snapshot;
const published = (old: boolean, side: boolean, over: Partial<Published> = {}): Published => ({
  version: 3,
  repositoryUrl: 'https://github.com/o/r',
  old,
  new: side,
  ...over,
});
const both = published(true, true);

describe('permalink', () => {
  it('links a side’s lines at its commit, an old side at the rename’s old path, paths escaped', () => {
    expect(permalink(snapshot, both, 'src/new name.ts', { side: 'new', startLine: 4, endLine: 4 })).toEqual({
      url: `https://github.com/o/r/blob/${NEW}/src/new%20name.ts#L4`,
    });
    expect(permalink(snapshot, both, 'src/new name.ts', { side: 'old', startLine: 2, endLine: 5 })).toEqual({
      url: `https://github.com/o/r/blob/${OLD}/src/old%23name.ts#L2-L5`,
    });
  });

  it('says why when GitHub could not show the lines', () => {
    const range = { side: 'new', startLine: 1, endLine: 1 } as const;
    const why = (p: Published, snap = snapshot) => permalink(snap, p, 'a.ts', range);
    expect([
      why(published(true, true, { version: 2 })),
      why(published(false, false, { repositoryUrl: null })),
      why(published(true, false)),
      why(published(true, false), { ...snapshot, newSha: 'worktree' }),
    ]).toEqual([
      { reason: 'The review changed; try again' },
      { reason: 'No GitHub origin to link to' },
      { reason: 'Not on GitHub: these lines are not in a pushed commit' },
      { reason: 'Uncommitted lines have no GitHub link' },
    ]);
  });
});
