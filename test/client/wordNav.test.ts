import { expect, it } from 'vitest';
import { wordsIn } from '../../src/client/lsp/wordNav.js';

it('uses UTF-16 offsets for Unicode words and skips punctuation', () => {
  expect(wordsIn('𐐀.x_2 + 42')).toEqual([
    { start: 0, text: '𐐀' },
    { start: 3, text: 'x_2' },
    { start: 9, text: '42' },
  ]);
});
