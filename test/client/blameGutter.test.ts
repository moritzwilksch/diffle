import { describe, expect, it, vi } from 'vitest';

// `relativeTime` formats in the host's locale, built at import: pin English before model.ts loads.
vi.hoisted(() => {
  const Native = Intl.RelativeTimeFormat;
  class English extends Native {
    constructor(_locales?: Intl.LocalesArgument, options?: Intl.RelativeTimeFormatOptions) {
      super('en', options);
    }
  }
  Object.defineProperty(Intl, 'RelativeTimeFormat', { value: English });
});
import type { BlameResponse } from '@/shared/protocol.js';
import { gutterLabel, gutterTitle, hunkAt } from '@/client/review/blameGutter.js';

const NOW = new Date(2026, 10, 11, 12).getTime();

const res: BlameResponse = {
  path: 'a.ts',
  side: 'new',
  hunks: [
    { start: 1, lines: 3, commit: 'aaa' },
    { start: 4, lines: 1, commit: null },
    { start: 5, lines: 2, commit: 'aaa' },
  ],
  commits: [
    {
      sha: 'aaa',
      short: 'aaa1234',
      author: 'Ada',
      time: new Date(2026, 7, 1, 10).getTime() / 1000,
      summary: 'Teach the parser commas',
    },
  ],
};

describe('gutter blame', () => {
  it('finds the hunk holding a line, none past the end', () => {
    expect([1, 3, 4, 5, 6, 7].map((line) => hunkAt(res, line)?.start)).toEqual([1, 1, 4, 5, 5, undefined]);
  });

  it('labels a commit by its local date and author, and a worktree line as uncommitted', () => {
    expect(gutterLabel(res, res.hunks[0]!)).toBe('2026-08-01 Ada');
    expect(gutterLabel(res, res.hunks[1]!)).toBe('Not committed yet');
  });

  it('puts what the label leaves out in the hover text', () => {
    expect(gutterTitle(res, res.hunks[0]!, NOW)).toBe('aaa1234 · Ada, 102 days ago\nTeach the parser commas');
    expect(gutterTitle(res, res.hunks[1]!, NOW)).toBe('');
  });
});
