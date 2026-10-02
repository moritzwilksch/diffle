import { DEFAULT_TOKENIZE_MAX_LENGTH, getSharedHighlighter, renderFileWithHighlighter } from '@pierre/diffs';
import { toHtml } from 'hast-util-to-html';
import { describe, expect, it } from 'vitest';
import { tokenTypeAt } from '../../src/client/lsp/target.js';
import { SHIKI_THEMES } from '../../src/client/theme.js';

/**
 * Guards the three vendored patches under `patches/`, which together carry Shiki's
 * TextMate token class through a dual-theme render and onto the rendered span. Drop any
 * one of them and the attribute disappears, so these assertions fail loudly.
 */
/**
 * Renders the way the viewer does: two themes at once. A single-theme render takes a
 * different path through Shiki and keeps `type` even unpatched, so it would pass here
 * while the app stayed blank.
 */
async function render(code: string, lang: string): Promise<string> {
  const highlighter = await getSharedHighlighter({ themes: [SHIKI_THEMES.light, SHIKI_THEMES.dark], langs: [lang] });
  const { code: lines } = renderFileWithHighlighter({ name: `file.${lang}`, contents: code, lang }, highlighter, {
    theme: SHIKI_THEMES,
    useTokenTransformer: true,
    tokenizeMaxLineLength: DEFAULT_TOKENIZE_MAX_LENGTH,
  });
  return lines.map((line) => toHtml(line)).join('\n');
}

describe('rendered token classification', () => {
  it('marks comments and string literals on the spans it paints', async () => {
    const html = await render('// note\nconst greeting = "hello";', 'typescript');
    expect(html).toContain('data-token-type="comment"');
    expect(html).toContain('data-token-type="string"');
    // Code keeps no attribute, so the symbol menu stays available on it.
    expect(html).not.toMatch(/data-token-type="[^"]*">const</);
  });

  it.each([
    ['python', '# note\nvalue = "hello"'],
    ['rust', '// note\nlet value = r#"hello"#;'],
    ['go', '// note\nvar value = `hello`'],
    ['lua', '-- note\nlocal value = [[hello]]'],
  ])('classifies comments and raw strings in %s', async (lang, code) => {
    const html = await render(code, lang);
    expect(html).toContain('data-token-type="comment"');
    expect(html).toContain('data-token-type="string"');
  });
});

describe('tokenTypeAt', () => {
  const span = (attrs: string): Element => {
    const el = {
      closest: (sel: string) => (sel === '[data-token-type]' && attrs ? { dataset: { tokenType: attrs } } : null),
    };
    return el as unknown as Element;
  };

  it('reads a classification the highlighter made', () => {
    expect(tokenTypeAt(span('comment'))).toBe('comment');
    expect(tokenTypeAt(span('string'))).toBe('string');
  });

  it('ignores an absent, empty or unknown classification', () => {
    expect(tokenTypeAt(null)).toBeNull();
    expect(tokenTypeAt(span(''))).toBeNull();
    expect(tokenTypeAt(span('keyword'))).toBeNull();
  });
});
