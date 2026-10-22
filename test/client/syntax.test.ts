import { beforeEach, describe, expect, it } from 'vitest';
import { SyntaxClassifier } from '@/client/lsp/SyntaxClassifier.js';
import { languageOf } from '@/client/lsp/syntax.js';

let classifier: SyntaxClassifier;
beforeEach(() => {
  classifier = new SyntaxClassifier();
});

function blocked(lang: string, source: string, text: string): boolean {
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
  ])('blocks comments and string text in %s', (lang, source) => {
    expect(blocked(lang, source, 'comment')).toBe(true);
    expect(blocked(lang, source, lang === 'typescript' ? 'literal' : 'string')).toBe(true);
    expect(blocked(lang, source, 'value')).toBe(false);
  });

  it.each([
    ['python', 'value = f"literal {symbol}"'],
    ['javascript', 'const value = `literal ${symbol}`'],
    ['ruby', 'value = "literal #{symbol}"'],
    ['shellscript', 'value="literal ${symbol}"'],
    ['swift', 'let value = "literal \\(symbol)"'],
  ])('keeps interpolated expressions actionable in %s', (lang, source) => {
    expect(blocked(lang, source, 'literal')).toBe(true);
    expect(blocked(lang, source, 'symbol')).toBe(false);
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
  ])('blocks grammar keywords in %s', (lang, source, keywords) => {
    for (const keyword of keywords) expect(blocked(lang, source, keyword), keyword).toBe(true);
  });

  it('allows keyword spellings used as identifiers or property names', () => {
    for (const name of ['export', 'function', 'const']) {
      expect(blocked('typescript', `object.${name}`, name)).toBe(false);
    }
    expect(blocked('typescript', 'const exported = value;', 'exported')).toBe(false);
    expect(blocked('typescript', 'const value = `text ${object.const}`;', 'const}')).toBe(false);
  });

  it('handles multiline syntax, Unicode columns, nested comments and JSX', () => {
    expect(blocked('python', 'value = """first\ncomment\nlast"""', 'comment')).toBe(true);
    expect(blocked('javascript', 'const café = "😀"; /* comment */ café;', 'comment')).toBe(true);
    expect(blocked('javascript', 'const x = `text ${/* comment */ symbol}`;', 'comment')).toBe(true);
    expect(blocked('tsx', 'const x = <div>text {symbol}</div>', 'text')).toBe(true);
    expect(blocked('tsx', 'const x = <div>text {symbol}</div>', 'symbol')).toBe(false);
  });

  it.each([
    ['rust', 'let x = r#"literal"#;'],
    ['go', 'var x = `literal`'],
    ['ocaml', 'let x = {foo|literal|foo}'],
    ['lua', 'local x = [[literal]]'],
    ['shellscript', "x='literal'"],
  ])('blocks raw and quoted strings in %s', (lang, source) => {
    expect(blocked(lang, source, 'literal')).toBe(true);
  });

  it('replaces cached states when contents change and evicts old files', () => {
    expect(blocked('python', '# value', 'value')).toBe(true);
    expect(blocked('python', '  value', 'value')).toBe(false);
    for (let n = 0; n < 12; n++) {
      expect(classifier.blocked(`file-${n}`, 'python', '# value', 1, 2)).toBe(true);
    }
    expect(blocked('python', '# value', 'value')).toBe(true);
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
  ])('keeps type names, interpolations, and methods actionable in %s: %s', (lang, source, text) => {
    expect(blocked(lang, source, text)).toBe(false);
  });

  it('keeps a string after an interpolation opener actionable, not a string after a type colon', () => {
    expect(blocked('python', 'value = f"{a.b:>10} literal"', 'a.b')).toBe(false);
    expect(blocked('typescript', 'let value: "literal";', 'literal')).toBe(true);
  });

  // Gaps in the lexers: these pin today's answers, so a fix upstream shows up here.
  it('blocks what the lexers leave unmarked: PHP interpolations, keyword-named object keys', () => {
    expect(blocked('php', '<?php $value = "literal {$symbol}";', 'symbol')).toBe(true);
    expect(blocked('javascript', 'const object = { export: value };', 'export:')).toBe(true);
  });

  it('carries state across many lines', () => {
    const source = ['const before = 1;', '/*', ...Array(250).fill('comment'), '*/', 'const after = before;'].join('\n');
    expect(classifier.blocked('file', 'typescript', source, 200, 0)).toBe(true);
    expect(classifier.blocked('file', 'typescript', source, 254, 6)).toBe(false);
    expect(classifier.blocked('file', 'typescript', source, 120, 0)).toBe(true);
  });

  it('leaves languages without a lexer alone', () => {
    expect(classifier.blocked('file', 'prisma', '// comment', 1, 3)).toBe(false);
  });

  it('leaves plain text, overlong lines, and oversized files alone', () => {
    expect(languageOf('notes.txt')).toBeNull();
    expect(languageOf('file.tsx')).toBe('tsx');
    expect(languageOf('flake.nix')).toBe('nix');
    expect(blocked('typescript', `// ${'x'.repeat(1000)} comment`, 'comment')).toBe(false);
    expect(classifier.blocked('large', 'python', '#'.repeat(1_000_001), 1, 0)).toBe(false);
  });
});
