import { describe, expect, it } from 'vitest';
import { ImportError, isDuplicate, parseImports } from '../../src/server/comments/import.js';
import type { CommentThread } from '../../src/shared/protocol.js';

describe('parseImports', () => {
  it('accepts one object or an array, as JSON text or a parsed value, and keeps only known fields', () => {
    const one = { path: 'a.py', startLine: 3, body: 'x', extra: 1 };
    expect(parseImports(JSON.stringify(one))).toEqual([{ path: 'a.py', startLine: 3, body: 'x' }]);
    expect(
      parseImports([
        one,
        { path: 'b.py', side: 'old', startLine: 1, endLine: 2, body: 'y', author: 'agent', quoted: 'q' },
      ]),
    ).toEqual([
      { path: 'a.py', startLine: 3, body: 'x' },
      { path: 'b.py', side: 'old', startLine: 1, endLine: 2, body: 'y', quoted: 'q' },
    ]);
  });

  it('reads a payload without a line as a comment on the whole file, and refuses line fields without one', () => {
    expect(parseImports({ path: 'a.py', body: 'Split this.' })).toEqual([{ path: 'a.py', body: 'Split this.' }]);
    for (const extra of [{ side: 'new' }, { endLine: 2 }, { quoted: 'q' }]) {
      expect(() => parseImports({ path: 'a.py', body: 'x', ...extra })).toThrow(/startLine/);
    }
  });

  it('rejects malformed payloads with the offending index', () => {
    expect(() => parseImports('{not json')).toThrow(ImportError);
    expect(() =>
      parseImports([
        { path: 'a.py', startLine: 1, body: 'ok' },
        { path: 'a.py', startLine: 0, body: 'x' },
      ]),
    ).toThrow(/\[1\].*startLine/);
    expect(() => parseImports({ path: 'a.py', startLine: 2, endLine: 1, body: 'x' })).toThrow(/endLine/);
    expect(() => parseImports({ path: 'a.py', startLine: 1, body: '  ' })).toThrow(/body/);
    expect(() => parseImports({ path: 'a.py', startLine: 1, body: 'x', side: 'left' })).toThrow(/side/);
    expect(() => parseImports('"a string"')).toThrow(/object/);
  });
});

describe('isDuplicate', () => {
  const existing: CommentThread[] = [
    {
      id: '1',
      anchor: { kind: 'line', path: 'a.py', side: 'new', startLine: 3, endLine: 4, quoted: 'q' },
      messages: [{ id: 'm', body: 'Same finding ', createdAt: 0, updatedAt: 0 }],
      resolved: false,
      stale: false,
    },
    {
      id: '2',
      anchor: { kind: 'line', path: 'a.py', side: 'new', startLine: 8, endLine: 8, quoted: 'q' },
      messages: [{ id: 'm', body: 'Resolved finding', createdAt: 0, updatedAt: 0 }],
      resolved: true,
      stale: false,
    },
  ];

  it('matches a file comment by path and body, never against a line thread', () => {
    const file: CommentThread = {
      ...existing[0]!,
      id: '3',
      anchor: { kind: 'file', path: 'a.py' },
      messages: [{ id: 'm', body: 'Whole file', createdAt: 0, updatedAt: 0 }],
    };
    expect(isDuplicate([...existing, file], { path: 'a.py', body: ' Whole file' })).toBe(true);
    expect(isDuplicate([...existing, file], { path: 'b.py', body: 'Whole file' })).toBe(false);
    expect(isDuplicate([...existing, file], { path: 'a.py', body: 'Same finding' })).toBe(false);
    expect(isDuplicate([...existing, file], { path: 'a.py', startLine: 1, body: 'Whole file' })).toBe(false);
  });

  it('matches path, side, range and trimmed opening body on open threads only', () => {
    expect(isDuplicate(existing, { path: 'a.py', startLine: 3, endLine: 4, body: 'Same finding' })).toBe(true);
    expect(isDuplicate(existing, { path: 'a.py', startLine: 3, endLine: 4, body: 'Other finding' })).toBe(false);
    expect(isDuplicate(existing, { path: 'a.py', startLine: 3, body: 'Same finding' })).toBe(false);
    expect(isDuplicate(existing, { path: 'a.py', side: 'old', startLine: 3, endLine: 4, body: 'Same finding' })).toBe(
      false,
    );
    expect(isDuplicate(existing, { path: 'a.py', startLine: 8, body: 'Resolved finding' })).toBe(false);
  });
});
