import type { ModeSpec } from '../shared/protocol.js';

export type ParsedRevspec = Pick<ModeSpec, 'old' | 'new' | 'mergeBase' | 'label'>;

/** The uncommitted tree, accepted on either side of a comparison. */
const WORKTREE = 'worktree';

/**
 * git-diff style revision arguments:
 *   "a"      → merge-base(a, HEAD) vs HEAD, i.e. "a...HEAD"
 *   "a..b"   → a vs b
 *   "a...b"  → merge-base(a, b) vs b
 *   "a" "b"  → a vs b
 * Empty sides default to HEAD. Either side accepts "worktree" for the uncommitted
 * tree; a merge base against it is taken against HEAD, the commit it sits on.
 */
export function parseRevspec(args: string[]): ParsedRevspec {
  if (args.length === 0 || args.length > 2) throw new RevspecError('expected one or two revisions');
  if (args.length === 2) {
    const [a, b] = args as [string, string];
    if (a.includes('..') || b.includes('..')) throw new RevspecError('cannot combine ".." with two revisions');
    return { old: a, new: b, mergeBase: false, label: `${a}..${b}` };
  }
  const arg = args[0]!;
  const three = arg.indexOf('...');
  if (three !== -1) {
    const a = arg.slice(0, three) || 'HEAD';
    const b = arg.slice(three + 3) || 'HEAD';
    return { old: a, new: b, mergeBase: true, label: `${a}...${b}` };
  }
  const two = arg.indexOf('..');
  if (two !== -1) {
    const a = arg.slice(0, two) || 'HEAD';
    const b = arg.slice(two + 2) || 'HEAD';
    return { old: a, new: b, mergeBase: false, label: `${a}..${b}` };
  }
  // A lone revision reviews what it and HEAD diverged into: the everyday "my branch" diff.
  if (arg === WORKTREE) return { old: 'HEAD', new: WORKTREE, mergeBase: false, label: `HEAD..${WORKTREE}` };
  return { old: arg, new: 'HEAD', mergeBase: true, label: `${arg}...HEAD` };
}

export class RevspecError extends Error {}
