import { describe, expect, it } from 'vitest';
import { ImportError, isDuplicate, parseImports } from '../../src/server/comments/import.js';
import type { CommentThread } from '../../src/shared/protocol.js';

describe('parseImports', () => {
  it('accepts one object or an array, as JSON text or a parsed value, and keeps only known fields', () => {
    const one = { path: 'a.py', startLine: 3, body: 'x', extra: 1 };
    expect(parseImports(JSON.stringify(one))).toEqual([{ path: 'a.py', startLine: 3, body: 'x' }]);
    expect(parseImports([one, { path: 'b.py', side: 'old', startLine: 1, endLine: 2, body: 'y', author: 'agent', authorName: 'claude', quoted: 'q' }])).toEqual([
      { path: 'a.py', startLine: 3, body: 'x' },
      { path: 'b.py', side: 'old', startLine: 1, endLine: 2, body: 'y', author: 'agent', authorName: 'claude', quoted: 'q' },
    ]);
  });

  it('rejects malformed payloads with the offending index', () => {
    expect(() => parseImports('{not json')).toThrow(ImportError);
    expect(() => parseImports([{ path: 'a.py', startLine: 1, body: 'ok' }, { path: 'a.py', startLine: 0, body: 'x' }])).toThrow(/\[1\].*startLine/);
    expect(() => parseImports({ path: 'a.py', startLine: 2, endLine: 1, body: 'x' })).toThrow(/endLine/);
    expect(() => parseImports({ path: 'a.py', startLine: 1, body: '  ' })).toThrow(/body/);
    expect(() => parseImports({ path: 'a.py', startLine: 1, body: 'x', side: 'left' })).toThrow(/side/);
    expect(() => parseImports({ path: 'a.py', startLine: 1, body: 'x', author: 'bot' })).toThrow(/author/);
    expect(() => parseImports('"a string"')).toThrow(/object/);
  });
});

describe('isDuplicate', () => {
  const existing: CommentThread[] = [
    {
      id: '1',
      anchor: { path: 'a.py', side: 'new', startLine: 3, endLine: 4, quoted: 'q' },
      messages: [{ id: 'm', author: 'agent', body: 'Same finding ', createdAt: 0, updatedAt: 0 }],
      resolved: false,
      stale: false,
    },
    {
      id: '2',
      anchor: { path: 'a.py', side: 'new', startLine: 8, endLine: 8, quoted: 'q' },
      messages: [{ id: 'm', author: 'agent', body: 'Resolved finding', createdAt: 0, updatedAt: 0 }],
      resolved: true,
      stale: false,
    },
  ];

  it('matches path, side, range and trimmed opening body on open threads only', () => {
    expect(isDuplicate(existing, { path: 'a.py', startLine: 3, endLine: 4, body: 'Same finding' })).toBe(true);
    expect(isDuplicate(existing, { path: 'a.py', startLine: 3, endLine: 4, body: 'Other finding' })).toBe(false);
    expect(isDuplicate(existing, { path: 'a.py', startLine: 3, body: 'Same finding' })).toBe(false);
    expect(isDuplicate(existing, { path: 'a.py', side: 'old', startLine: 3, endLine: 4, body: 'Same finding' })).toBe(false);
    expect(isDuplicate(existing, { path: 'a.py', startLine: 8, body: 'Resolved finding' })).toBe(false);
  });
});
