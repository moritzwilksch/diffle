import { describe, expect, it } from 'vitest';
import { permalink } from '@/client/review/permalink.js';
import type { GithubMetadata, Snapshot } from '@/shared/protocol.js';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const snapshot = {
  version: 3,
  oldSha: OLD,
  newSha: NEW,
  changed: [{ path: 'src/new name.ts', oldPath: 'src/old#name.ts', status: 'R' }],
} as unknown as Snapshot;
const github = (published: GithubMetadata['published'], over: Partial<GithubMetadata> = {}): GithubMetadata => ({
  version: 3,
  repository: 'o/r',
  repositoryUrl: 'https://github.com/o/r',
  published,
  pullRequest: null,
  reason: null,
  ...over,
});
const both = github({ old: true, new: true });

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
    const reason = (g: GithubMetadata | undefined) => {
      const link = permalink(snapshot, g, 'a.ts', range);
      return 'reason' in link ? link.reason : link.url;
    };
    expect([
      reason(undefined),
      reason(github({ old: true, new: true }, { version: 2 })),
      reason(github({ old: false, new: false }, { repository: null, repositoryUrl: null })),
      reason(github({ old: true, new: false })),
    ]).toEqual([
      'GitHub lookup still running',
      'GitHub lookup still running',
      'No GitHub origin to link to',
      'Not on GitHub: these lines are not in a pushed commit',
    ]);
  });
});
