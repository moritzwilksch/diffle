import type { OldSpec } from '../shared/protocol.js';

export interface ParsedRevspec {
  old: OldSpec;
  newRev: string | 'worktree';
  label: string;
}

/**
 * git-diff style revision arguments:
 *   "a"      → a vs worktree
 *   "a..b"   → a vs b
 *   "a...b"  → merge-base(a, b) vs b
 *   "a" "b"  → a vs b
 * Empty sides default to HEAD.
 */
export function parseRevspec(args: string[]): ParsedRevspec {
  if (args.length === 0 || args.length > 2) throw new RevspecError('expected one or two revisions');
  if (args.length === 2) {
    const [a, b] = args as [string, string];
    if (a.includes('..') || b.includes('..')) throw new RevspecError('cannot combine ".." with two revisions');
    return { old: { kind: 'rev', rev: a }, newRev: b, label: `${a}..${b}` };
  }
  const arg = args[0]!;
  const three = arg.indexOf('...');
  if (three !== -1) {
    const a = arg.slice(0, three) || 'HEAD';
    const b = arg.slice(three + 3) || 'HEAD';
    return { old: { kind: 'merge-base', a, b }, newRev: b, label: `${a}...${b}` };
  }
  const two = arg.indexOf('..');
  if (two !== -1) {
    const a = arg.slice(0, two) || 'HEAD';
    const b = arg.slice(two + 2) || 'HEAD';
    return { old: { kind: 'rev', rev: a }, newRev: b, label: `${a}..${b}` };
  }
  return { old: { kind: 'rev', rev: arg }, newRev: 'worktree', label: `${arg} → worktree` };
}

export class RevspecError extends Error {}
