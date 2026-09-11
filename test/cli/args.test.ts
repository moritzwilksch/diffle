import { describe, expect, it } from 'vitest';
import { collectLanguage, collectLspOverride, parseContext, parsePort } from '../../src/cli/args.js';

describe('CLI numeric arguments', () => {
  it('accepts integers in range', () => {
    expect(parsePort('0')).toBe(0);
    expect(parsePort('65535')).toBe(65535);
    expect(parseContext('12')).toBe(12);
  });

  it('rejects non-integers and out-of-range values as usage errors', () => {
    for (const bad of ['nope', '', '1.5', '-1', '65536'])
      expect(() => parsePort(bad)).toThrow(/integer between 0 and 65535/);
    expect(() => parseContext('10001')).toThrow(/integer between 0 and 10000/);
  });
});

describe('variadic <language...>', () => {
  it('appends every value, so a command sees all of them', () => {
    expect(collectLanguage('go', collectLanguage('python'))).toEqual(['python', 'go']);
  });

  it('rejects a language diffle does not know', () => {
    expect(() => collectLanguage('nope')).toThrow(/unknown language "nope"/);
    expect(() => collectLanguage('nope', ['go'])).toThrow(/unknown language "nope"/);
  });
});

describe('--lsp collection', () => {
  it('collects one override per flag, in order', () => {
    const first = collectLspOverride('python=pyrefly lsp', true);
    expect(first).toEqual([{ language: 'python', command: 'pyrefly lsp' }]);
    expect(collectLspOverride('go=gopls', first)).toEqual([
      { language: 'python', command: 'pyrefly lsp' },
      { language: 'go', command: 'gopls' },
    ]);
  });

  it('rejects a value that names no language', () => {
    expect(() => collectLspOverride('', true)).toThrow(/expected <language>=<command>/);
    expect(() => collectLspOverride('pyrefly lsp', true)).toThrow(/expected <language>=<command>/);
    expect(() => collectLspOverride('nope=x', true)).toThrow(/unknown language "nope"/);
  });
});
