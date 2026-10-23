import { describe, expect, it } from 'vitest';
import { permalink } from '@/client/review/permalink.js';
import type { GithubState } from '@/client/store.js';
import type { GithubMetadata, Snapshot } from '@/shared/protocol.js';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const snapshot = {
  version: 3,
  oldSha: OLD,
  newSha: NEW,
  changed: [{ path: 'src/new name.ts', oldPath: 'src/old#name.ts', status: 'R' }],
} as unknown as Snapshot;
const ready = (published: GithubMetadata['published'], over: Partial<GithubMetadata> = {}): GithubState => ({
  status: 'ready',
  data: {
    version: 3,
    repository: 'o/r',
    repositoryUrl: 'https://github.com/o/r',
    published,
    pullRequest: null,
    reason: null,
    ...over,
  },
});
const both = ready({ old: true, new: true });

describe('permalink', () => {
  it('links a side’s lines at its commit, an old side at the rename’s old path, paths escaped', () => {
    expect(permalink(snapshot, both, 'src/new name.ts', { side: 'new', startLine: 4, endLine: 4 })).toEqual({
      url: `https://github.com/o/r/blob/${NEW}/src/new%20name.ts#L4`,
    });
    expect(permalink(snapshot, both, 'src/new name.ts', { side: 'old', startLine: 2, endLine: 5 })).toEqual({
      url: `https://github.com/o/r/blob/${OLD}/src/old%23name.ts#L2-L5`,
    });
  });

  it('says why when GitHub could not show the lines, and when a push could change that', () => {
    const range = { side: 'new', startLine: 1, endLine: 1 } as const;
    const why = (github: GithubState, snap = snapshot) => permalink(snap, github, 'a.ts', range);
    expect([
      why({ status: 'idle' }),
      why({ status: 'loading' }),
      why({ status: 'error', error: 'HTTP 502' }),
      why(ready({ old: true, new: true }, { version: 2 })),
      why(ready({ old: false, new: false }, { repository: null, repositoryUrl: null })),
      why(ready({ old: true, new: false })),
      why(ready({ old: true, new: false }), { ...snapshot, newSha: 'worktree' }),
    ]).toEqual([
      { reason: 'No GitHub lookup yet' },
      { reason: 'GitHub lookup still running' },
      { reason: 'GitHub lookup failed: HTTP 502' },
      { reason: 'GitHub lookup still running' },
      { reason: 'No GitHub origin to link to' },
      { reason: 'Not on GitHub: these lines are not in a pushed commit', unpushed: true },
      { reason: 'Uncommitted lines have no GitHub link' },
    ]);
  });
});
