// @vitest-environment jsdom
import { getSharedHighlighter } from '@pierre/diffs';
import { describe, expect, it } from 'vitest';
import { isSymbolToken } from '../../src/client/lsp/target.js';
import { NON_CODE_COLORS, SHIKI_THEMES } from '../../src/client/theme.js';

function token(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host.firstElementChild as HTMLElement;
}

describe('isSymbolToken', () => {
  it('rejects tokens painted in the comment or string color, whatever the case', () => {
    expect(
      isSymbolToken(token('<span style="--diffs-token-light:#66707B;--diffs-token-dark:#BDC4CC"># moved</span>')),
    ).toBe(false);
    expect(
      isSymbolToken(token('<span style="--diffs-token-light:#032563;--diffs-token-dark:#ADDCFF">"moved"</span>')),
    ).toBe(false);
  });

  it('accepts code tokens and unstyled text', () => {
    expect(
      isSymbolToken(token('<span style="--diffs-token-light:#0E1116;--diffs-token-dark:#F0F3F6">moved</span>')),
    ).toBe(true);
    expect(isSymbolToken(token('<span data-char="0">moved</span>'))).toBe(true);
  });

  it('reads the color off the fragments of a merged token', () => {
    const merged =
      '<span data-char="4"><span style="--diffs-token-light:#66707B">mo</span><span style="--diffs-token-light:#66707B">ved</span></span>';
    expect(isSymbolToken(token(merged))).toBe(false);
  });
});

describe('NON_CODE_COLORS', () => {
  it('matches what the light theme paints Python comments and strings with', async () => {
    const highlighter = await getSharedHighlighter({ themes: [SHIKI_THEMES.light], langs: ['python'] });
    const colorOf = (code: string) =>
      highlighter.codeToTokensBase(code, { lang: 'python', theme: SHIKI_THEMES.light })[0]![0]!.color!.toLowerCase();
    expect(NON_CODE_COLORS).toEqual(new Set([colorOf('# comment'), colorOf('"string"')]));
  });
});
