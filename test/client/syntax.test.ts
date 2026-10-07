import { createHighlighter, createJavaScriptRegexEngine, type Highlighter } from 'shiki';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SyntaxClassifier } from '../../src/client/lsp/SyntaxClassifier.js';
import { languageOf } from '../../src/client/lsp/syntax.js';

// prettier-ignore
const LANGS = ['python', 'javascript', 'typescript', 'tsx', 'rust', 'go', 'c', 'cpp', 'ruby', 'java', 'lua', 'zig', 'swift', 'php', 'shellscript', 'ocaml', 'csharp', 'kotlin'];
let highlighter: Highlighter;
let classifier: SyntaxClassifier;
beforeAll(async () => {
  highlighter = await createHighlighter({ themes: [], langs: LANGS, engine: createJavaScriptRegexEngine() });
}, 30_000);
beforeEach(() => {
  classifier = new SyntaxClassifier((lang) => highlighter.getLanguage(lang));
});

async function blocked(lang: string, source: string, text: string): Promise<boolean> {
  const offset = source.indexOf(text);
  expect(offset).toBeGreaterThanOrEqual(0);
  const before = source.slice(0, offset).split('\n');
  return classifier.blocked('file', lang, source, before.length, before.at(-1)!.length);
}

describe('client syntax classification', () => {
  it.each([
    ['python', '# comment\nvalue = "string"\nvalue'],
    ['javascript', '// comment\nconst value = "string"; value'],
    ['typescript', '/* comment */\nconst value: string = "literal"; value'],
    ['rust', '// comment\nlet value = "string"; value;'],
    ['go', '// comment\nvar value = "string"'],
    ['c', '/* comment */\nchar *value = "string";'],
    ['cpp', '// comment\nauto value = "string";'],
    ['ruby', '# comment\nvalue = "string"'],
    ['java', '// comment\nclass A { String value = "string"; }'],
    ['lua', '-- comment\nlocal value = "string"'],
    ['zig', '// comment\nconst value = "string";'],
    ['swift', '// comment\nlet value = "string"'],
    ['php', '<?php // comment\n$value = "string";'],
    ['shellscript', '# comment\nvalue="string"'],
    ['ocaml', '(* comment *)\nlet value = "string"'],
    ['tsx', '// comment\nconst value = <div title="string">text</div>;'],
  ])('blocks comments and string text in %s', async (lang, source) => {
    expect(await blocked(lang, source, 'comment')).toBe(true);
    expect(await blocked(lang, source, lang === 'typescript' ? 'literal' : 'string')).toBe(true);
    expect(await blocked(lang, source, 'value')).toBe(false);
  });

  it.each([
    ['python', 'value = f"literal {symbol}"'],
    ['javascript', 'const value = `literal ${symbol}`'],
    ['ruby', 'value = "literal #{symbol}"'],
    ['shellscript', 'value="literal ${symbol}"'],
    ['swift', 'let value = "literal \\(symbol)"'],
    ['php', '<?php $value = "literal {$symbol}";'],
  ])('keeps interpolated expressions actionable in %s', async (lang, source) => {
    expect(await blocked(lang, source, 'literal')).toBe(true);
    expect(await blocked(lang, source, 'symbol')).toBe(false);
  });

  it.each([
    [
      'typescript',
      'export function value() { const local = 1; return local; }',
      ['export', 'function', 'const', 'return'],
    ],
    [
      'javascript',
      'export function value() { const local = 1; return local; }',
      ['export', 'function', 'const', 'return'],
    ],
    ['python', 'def value():\n  if ready:\n    return ready', ['def', 'if', 'return']],
    ['rust', 'pub fn value() { let local = 1; }', ['pub', 'fn', 'let']],
    ['go', 'func value() { var local = 1 }', ['func', 'var']],
    ['c', 'static void value() { return; }', ['static', 'return']],
    ['cpp', 'namespace value { class Thing {}; }', ['namespace', 'class']],
    ['ruby', 'def value\n  return local\nend', ['def', 'return', 'end']],
    ['kotlin', 'private val a = 1\noverride fun b() {}', ['private', 'val', 'override', 'fun']],
    ['java', 'public class Value { static void value() {} }', ['public', 'class', 'static']],
    ['lua', 'local function value() return localValue end', ['local', 'function', 'return', 'end']],
    ['zig', 'pub fn value() void { const local = 1; }', ['pub', 'fn', 'const']],
    ['swift', 'public func value() { let local = 1 }', ['public', 'func', 'let']],
    ['php', '<?php function value() { return 1; }', ['function', 'return']],
    ['shellscript', 'if test -f path; then echo value; fi', ['if', 'then', 'fi']],
    ['ocaml', 'let value = if ready then 1 else 0', ['let', 'if', 'then', 'else']],
    ['tsx', 'export const value = <div />;', ['export', 'const']],
  ])('blocks grammar keywords in %s', async (lang, source, keywords) => {
    for (const keyword of keywords) expect(await blocked(lang, source, keyword), keyword).toBe(true);
  });

  it('allows keyword spellings used as identifiers or property names', async () => {
    for (const name of ['export', 'function', 'const']) {
      expect(await blocked('typescript', `object.${name}`, name)).toBe(false);
      expect(await blocked('javascript', `const object = { ${name}: value };`, `${name}:`)).toBe(false);
    }
    expect(await blocked('typescript', 'const exported = value;', 'exported')).toBe(false);
    expect(await blocked('typescript', 'const value = `text ${object.const}`;', 'const}')).toBe(false);
  });

  it('handles multiline syntax, Unicode columns, nested comments and JSX', async () => {
    expect(await blocked('python', 'value = """first\ncomment\nlast"""', 'comment')).toBe(true);
    expect(await blocked('javascript', 'const café = "😀"; /* comment */ café;', 'comment')).toBe(true);
    expect(await blocked('javascript', 'const x = `text ${/* comment */ symbol}`;', 'comment')).toBe(true);
    expect(await blocked('tsx', 'const x = <div>text {symbol}</div>', 'text')).toBe(true);
    expect(await blocked('tsx', 'const x = <div>text {symbol}</div>', 'symbol')).toBe(false);
  });

  it.each([
    ['rust', 'let x = r#"literal"#;'],
    ['go', 'var x = `literal`'],
    ['ocaml', 'let x = {foo|literal|foo}'],
    ['lua', 'local x = [[literal]]'],
    ['shellscript', "x='literal'"],
  ])('blocks raw and quoted strings in %s', async (lang, source) => {
    expect(await blocked(lang, source, 'literal')).toBe(true);
  });

  it('replaces cached states when contents change and evicts old files', async () => {
    expect(await blocked('python', '# value', 'value')).toBe(true);
    expect(await blocked('python', '  value', 'value')).toBe(false);
    for (let n = 0; n < 12; n++) {
      expect(await classifier.blocked(`file-${n}`, 'python', '# value', 1, 2)).toBe(true);
    }
    expect(await blocked('python', '# value', 'value')).toBe(true);
  });

  it.each([
    ['typescript', 'let value: string;', 'string'],
    ['java', 'String value; int count;', 'String'],
    ['java', 'String value; int count;', 'int'],
    ['go', 'var value string', 'string'],
    ['c', 'char *value; size_t size;', 'size_t'],
    ['csharp', 'int value;', 'int'],
    ['kotlin', 'val s = "literal ${symbol}"', 'symbol'],
    ['ruby', 'Widget.new', 'new'],
    ['ruby', 'object.include(value)', 'include'],
  ])('keeps type names, interpolations, and methods actionable in %s: %s', async (lang, source, text) => {
    expect(await blocked(lang, source, text)).toBe(false);
  });

  it('carries state across checkpoints into lines far below', async () => {
    const source = ['const before = 1;', '/*', ...Array(250).fill('comment'), '*/', 'const after = before;'].join('\n');
    expect(await classifier.blocked('file', 'typescript', source, 200, 0)).toBe(true);
    expect(await classifier.blocked('file', 'typescript', source, 254, 6)).toBe(false);
    expect(await classifier.blocked('file', 'typescript', source, 120, 0)).toBe(true);
  });

  it('leaves plain text, overlong lines, and oversized files alone', async () => {
    expect(languageOf('notes.txt')).toBeNull();
    expect(languageOf('file.tsx')).toBe('tsx');
    expect(languageOf('flake.nix')).toBe('nix');
    expect(await blocked('typescript', `// ${'x'.repeat(1000)} comment`, 'comment')).toBe(false);
    expect(await classifier.blocked('large', 'python', '#'.repeat(1_000_001), 1, 0)).toBe(false);
  });
});
