// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import type { GithubMetadata, Snapshot } from '@/shared/protocol.js';

const api = { github: vi.fn() };
vi.mock('@/client/api.js', () => ({ api }));
const writeText = vi.fn();
Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

const { useStore } = await import('@/client/store.js');
const { copyCursorPermalink } = await import('@/client/review/permalink.js');

const NEW = 'b'.repeat(40);
const snapshot = { version: 1, oldSha: 'a'.repeat(40), newSha: NEW, changed: [] } as unknown as Snapshot;
const metadata = (pushed: boolean): GithubMetadata => ({
  version: 1,
  repository: 'o/r',
  repositoryUrl: 'https://github.com/o/r',
  published: { old: true, new: pushed },
  pullRequest: null,
  reason: null,
});

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  api.github.mockReset();
  useStore.setState({
    snapshot,
    selection: { id: 'diff:a.ts@0', range: { start: 3, side: 'additions', end: 3, endSide: 'additions' } },
    github: { status: 'ready', data: metadata(false) },
  });
});

it('looks again before giving up on unpushed lines, so a push since the last lookup copies', async () => {
  api.github.mockResolvedValueOnce(metadata(true));
  await copyCursorPermalink();
  expect(api.github).toHaveBeenCalledTimes(1);
  expect(writeText).toHaveBeenCalledWith(`https://github.com/o/r/blob/${NEW}/a.ts#L3`);
  expect(useStore.getState().toast).toBe('Copied GitHub link');
});

it('says the lines are unpushed when the fresh lookup agrees', async () => {
  api.github.mockResolvedValueOnce(metadata(false));
  await copyCursorPermalink();
  expect(writeText).not.toHaveBeenCalled();
  expect(useStore.getState().toast).toBe('Not on GitHub: these lines are not in a pushed commit');
});
