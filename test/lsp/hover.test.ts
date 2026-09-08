import { describe, expect, it } from 'vitest';
import { hoverMarkdown } from '../../src/server/lsp/hover.js';

describe('hoverMarkdown', () => {
  it('passes markdown through and drops empty results', () => {
    expect(hoverMarkdown({ kind: 'markdown', value: '**f**' })).toBe('**f**');
    expect(hoverMarkdown('plain md')).toBe('plain md');
    expect(hoverMarkdown(null)).toBeNull();
    expect(hoverMarkdown([])).toBeNull();
    expect(hoverMarkdown({ kind: 'markdown', value: '  \n' })).toBeNull();
  });

  it('fences plaintext and language blocks, longer than any backtick run inside', () => {
    expect(hoverMarkdown({ kind: 'plaintext', value: 'x: int\n' })).toBe('```\nx: int\n```');
    expect(hoverMarkdown({ language: 'python', value: 'a = ``` + 1' })).toBe('````python\na = ``` + 1\n````');
  });

  it('joins the parts of a list with a blank line', () => {
    expect(hoverMarkdown([{ language: 'python', value: 'def f()' }, '', 'doc'])).toBe('```python\ndef f()\n```\n\ndoc');
  });
});
