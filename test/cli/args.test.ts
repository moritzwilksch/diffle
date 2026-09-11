import { describe, expect, it } from 'vitest';
import {
  collectLanguage,
  collectLspOverride,
  parseContext,
  parsePort,
  parseAllowedOrigin,
} from '../../src/cli/args.js';

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

describe('--allowed-origin', () => {
  it('normalizes HTTP(S) origins', () => {
    expect(parseAllowedOrigin('https://Proxy.example:443/')).toBe('https://proxy.example');
    expect(parseAllowedOrigin('http://proxy.example:8080')).toBe('http://proxy.example:8080');
  });

  it.each([
    'null',
    '*',
    'proxy.example',
    'ftp://proxy.example',
    'https://u:p@proxy.example',
    'https://proxy.example/prefix/',
    'https://proxy.example/?q=1',
    'https://proxy.example/#x',
    'https://proxy.example/prefix/..',
    'https://proxy.example?',
    'https://proxy.example#',
  ])('rejects %s', (value) => {
    expect(() => parseAllowedOrigin(value)).toThrow(/expected an HTTP\(S\) origin/);
  });
});
