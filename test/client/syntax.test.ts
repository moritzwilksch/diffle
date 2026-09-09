import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Language, Parser } from 'web-tree-sitter';
import { SyntaxClassifier } from '../../src/client/lsp/SyntaxClassifier.js';
import { GRAMMARS, grammarOf } from '../../src/client/lsp/syntax.js';

const languages = new Map<string, Promise<Language>>();
const classifier = new SyntaxClassifier(async (grammar) => {
  let language = languages.get(grammar);
  if (!language) {
    language = Language.load(
      grammar === 'lua'
        ? 'node_modules/@tree-sitter-grammars/tree-sitter-lua/tree-sitter-lua.wasm'
        : `node_modules/tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`,
    );
    languages.set(grammar, language);
  }
  const loaded = await language;
  const parser = new Parser();
  parser.setLanguage(loaded);
  return parser;
});
beforeAll(async () => {
  await Parser.init();
});
afterEach(() => classifier.dispose());

async function blocked(grammar: string, source: string, text: string): Promise<boolean> {
  const offset = source.indexOf(text);
  expect(offset).toBeGreaterThanOrEqual(0);
  const before = source.slice(0, offset).split('\n');
  return classifier.blocked('file', grammar, source, before.length, before.at(-1)!.length);
}

describe('client syntax classification', () => {
  it.each([...new Set(Object.values(GRAMMARS))])('loads the bundled %s grammar', async (grammar) => {
    await expect(classifier.blocked('file', grammar, '', 1, 0)).resolves.toBe(false);
  });

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
    ['bash', '# comment\nvalue="string"'],
    ['ocaml', '(* comment *)\nlet value = "string"'],
    ['tsx', '// comment\nconst value = <div title="string">text</div>;'],
  ])('blocks comments and string text in %s', async (grammar, source) => {
    expect(await blocked(grammar, source, 'comment')).toBe(true);
    expect(await blocked(grammar, source, grammar === 'typescript' ? 'literal' : 'string')).toBe(true);
    expect(await blocked(grammar, source, 'value')).toBe(false);
  });

  it.each([
    ['python', 'value = f"literal {symbol}"'],
    ['javascript', 'const value = `literal ${symbol}`'],
    ['ruby', 'value = "literal #{symbol}"'],
    ['bash', 'value="literal ${symbol}"'],
    ['swift', 'let value = "literal \\(symbol)"'],
    ['php', '<?php $value = "literal {$symbol}";'],
  ])('keeps interpolated expressions actionable in %s', async (grammar, source) => {
    expect(await blocked(grammar, source, 'literal')).toBe(true);
    expect(await blocked(grammar, source, 'symbol')).toBe(false);
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
    ['java', 'public class Value { static void value() {} }', ['public', 'class', 'static']],
    ['lua', 'local function value() return localValue end', ['local', 'function', 'return', 'end']],
    ['zig', 'pub fn value() void { const local = 1; }', ['pub', 'fn', 'const']],
    ['swift', 'public func value() { let local = 1 }', ['public', 'func', 'let']],
    ['php', '<?php function value() { return 1; }', ['function', 'return']],
    ['bash', 'if test -f path; then echo value; fi', ['if', 'then', 'fi']],
    ['ocaml', 'let value = if ready then 1 else 0', ['let', 'if', 'then', 'else']],
    ['tsx', 'export const value = <div />;', ['export', 'const']],
  ])('blocks grammar keywords in %s', async (grammar, source, keywords) => {
    for (const keyword of keywords) expect(await blocked(grammar, source, keyword), keyword).toBe(true);
  });

  it('classifies Lua keywords after replacing a tree containing strings', async () => {
    expect(await blocked('lua', 'local value = "string"', 'string')).toBe(true);
    expect(await blocked('lua', 'local function value() return 1 end', 'end')).toBe(true);
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
    ['bash', "x='literal'"],
  ])('blocks raw and quoted strings in %s', async (grammar, source) => {
    expect(await blocked(grammar, source, 'literal')).toBe(true);
  });

  it('replaces cached trees when contents change and evicts old files', async () => {
    expect(await blocked('python', '# value', 'value')).toBe(true);
    expect(await blocked('python', '  value', 'value')).toBe(false);
    for (let n = 0; n < 12; n++) {
      expect(await classifier.blocked(`file-${n}`, 'python', '# value', 1, 2)).toBe(true);
    }
    expect(await blocked('python', '# value', 'value')).toBe(true);
  });

  it('leaves unsupported languages and oversized files alone', async () => {
    expect(grammarOf('file.nix')).toBeNull();
    expect(grammarOf('file.txt')).toBeNull();
    expect(grammarOf('file.tsx')).toBe('tsx');
    expect(await classifier.blocked('large', 'python', '#'.repeat(1_000_001), 1, 0)).toBe(false);
  });
});
