// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { MatchCache, matchPattern } from '../../src/client/search/highlight.js';
import type { SearchState } from '../../src/client/store.js';

const base: SearchState = { open: true, kind: 'text', direction: 1, ignoreCase: true, regex: false, scope: 'diff', path: null, focusNonce: 0, query: 'a.b', matches: [{ path: 'x', line: 1, text: '' }], index: 0, loading: false, truncated: false };
const hits = (s: Partial<SearchState>, text: string) => [...text.matchAll(matchPattern({ ...base, ...s })!)].map((m) => m[0]);

describe('search highlight pattern', () => {
  it('follows the text-search toggles', () => {
    expect(hits({}, 'a.b A.B axb')).toEqual(['a.b', 'A.B']);
    expect(hits({ ignoreCase: false }, 'a.b A.B')).toEqual(['a.b']);
    expect(hits({ regex: true }, 'a.b A.B axb')).toEqual(['a.b', 'A.B', 'axb']);
    expect(matchPattern({ ...base, regex: true, query: '(' })).toBeNull();
  });
  it('word searches match whole identifiers, case-sensitively', () => {
    expect(hits({ kind: 'word', query: 'foo' }, 'foo foobar _foo Foo foo.bar')).toEqual(['foo', 'foo']);
  });
  it('paints nothing for references or a closed / empty search', () => {
    expect(matchPattern({ ...base, kind: 'references' })).toBeNull();
    expect(matchPattern({ ...base, open: false })).toBeNull();
    expect(matchPattern({ ...base, matches: [] })).toBeNull();
  });
});

const row = (html: string): HTMLElement => {
  const el = document.createElement('div');
  el.dataset.line = '1';
  el.innerHTML = html;
  return el;
};

describe('per-row match cache', () => {
  it('spans token boundaries in the real DOM', () => {
    const r = row('<span>fo</span><span>o.b</span>ar foo');
    const ranges = new MatchCache().rangesFor(r, /foo/g);
    expect(ranges.map(String)).toEqual(['foo', 'foo']);
  });
  it('scans a row once while the pattern holds and rescans only invalidated rows', () => {
    const scan = vi.fn((el: Element) => [el.textContent] as unknown as Range[]);
    const cache = new MatchCache(scan);
    const a = row('<span>foo</span>');
    const b = row('bar');
    const pattern = /foo/g;
    const first = cache.rangesFor(a, pattern);
    cache.rangesFor(b, pattern);
    expect(scan).toHaveBeenCalledTimes(2);
    // A scroll frame that exposes the same rows returns the cached ranges by identity.
    expect(cache.rangesFor(a, pattern)).toBe(first);
    expect(cache.rangesFor(a, /foo/g)).toBe(first);
    cache.rangesFor(b, pattern);
    expect(scan).toHaveBeenCalledTimes(2);
    // A mutation inside `a` drops only `a`.
    a.querySelector('span')!.firstChild!.textContent = 'food';
    cache.invalidate(a.querySelector('span')!.firstChild!);
    expect(cache.rangesFor(a, pattern)).toEqual(['food']);
    cache.rangesFor(b, pattern);
    expect(scan).toHaveBeenCalledTimes(3);
    // Mutations outside any row leave the cache alone.
    cache.invalidate(document.body);
    cache.rangesFor(a, pattern);
    expect(scan).toHaveBeenCalledTimes(3);
  });
  it('drops every row when the pattern or its flags change', () => {
    const scan = vi.fn(() => [] as Range[]);
    const cache = new MatchCache(scan);
    const a = row('foo');
    const b = row('foo');
    cache.rangesFor(a, /foo/g);
    cache.rangesFor(b, /foo/g);
    cache.rangesFor(a, /foo/gi);
    cache.rangesFor(b, /foo/gi);
    expect(scan).toHaveBeenCalledTimes(4);
    cache.rangesFor(a, /fo/gi);
    cache.rangesFor(b, /fo/gi);
    expect(scan).toHaveBeenCalledTimes(6);
    cache.rangesFor(a, /fo/gi);
    expect(scan).toHaveBeenCalledTimes(6);
  });
});
