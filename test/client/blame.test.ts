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
import { blameNote } from '@/client/review/blame.js';

const NOW = Date.UTC(2026, 10, 11, 12);
const DAY = 86_400;

const res: BlameResponse = {
  path: 'a.ts',
  side: 'new',
  hunks: [
    { start: 1, lines: 2, commit: 'aaa' },
    { start: 3, lines: 1, commit: null },
    { start: 4, lines: 1, commit: 'bbb' },
  ],
  commits: [
    { sha: 'aaa', short: 'aaa', author: 'Ada', time: NOW / 1000 - 3 * DAY, summary: 'Teach the parser commas' },
    { sha: 'bbb', short: 'bbb', author: 'Bea', time: NOW / 1000 - 60, summary: 'x'.repeat(100) },
  ],
};

describe('blameNote', () => {
  it('names the author, when, and the subject of the line’s commit', () => {
    expect(blameNote(res, 2, NOW)).toBe('Ada, 3 days ago · Teach the parser commas');
  });

  it('says a worktree line is not committed yet', () => {
    expect(blameNote(res, 3, NOW)).toBe('Not committed yet');
  });

  it('cuts a long subject short', () => {
    expect(blameNote(res, 4, NOW)).toBe(`Bea, 1 minute ago · ${'x'.repeat(71)}…`);
  });

  it('has nothing for a line the response does not cover', () => {
    expect(blameNote(res, 9, NOW)).toBeNull();
  });
});
