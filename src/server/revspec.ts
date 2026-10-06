import type { ModeSpec } from '../shared/protocol.js';

export type ParsedRevspec = Pick<ModeSpec, 'old' | 'new' | 'base'>;

/** The uncommitted tree, accepted on either side of a comparison. */
const WORKTREE = 'worktree';

/**
 * git-diff style revision arguments:
 *   "a"      → merge-base(a, HEAD) vs HEAD, i.e. "a...HEAD"
 *   "a..b"   → a vs b
 *   "a...b"  → merge-base(a, b) vs b
 *   "a" "b"  → a vs b
 *   "a^!"    → a vs its first parent: the one commit, as git show shows it
 * Empty sides default to HEAD. Either side accepts "worktree" for the uncommitted
 * tree; a merge base against it is taken against HEAD, the commit it sits on.
 */
export function parseRevspec(args: string[]): ParsedRevspec {
  if (args.length === 0 || args.length > 2) throw new RevspecError('expected one or two revisions');
  if (args.length === 2) {
    const [a, b] = args as [string, string];
    if (a.includes('..') || b.includes('..')) throw new RevspecError('cannot combine ".." with two revisions');
    if (a.endsWith('^!') || b.endsWith('^!')) throw new RevspecError('cannot combine "^!" with two revisions');
    return { old: a, new: b, base: 'direct' };
  }
  const arg = args[0]!;
  if (arg.endsWith('^!')) {
    const commit = arg.slice(0, -2) || 'HEAD';
    if (commit.includes('..')) throw new RevspecError('cannot combine "^!" with ".."');
    if (commit === WORKTREE) throw new RevspecError('the worktree is not a commit');
    return { old: commit, new: commit, base: 'parent' };
  }
  const three = arg.indexOf('...');
  if (three !== -1) {
    const a = arg.slice(0, three) || 'HEAD';
    const b = arg.slice(three + 3) || 'HEAD';
    return { old: a, new: b, base: 'merge-base' };
  }
  const two = arg.indexOf('..');
  if (two !== -1) {
    const a = arg.slice(0, two) || 'HEAD';
    const b = arg.slice(two + 2) || 'HEAD';
    return { old: a, new: b, base: 'direct' };
  }
  // A lone revision reviews what it and HEAD diverged into: the everyday "my branch" diff.
  if (arg === WORKTREE) return { old: 'HEAD', new: WORKTREE, base: 'direct' };
  return { old: arg, new: 'HEAD', base: 'merge-base' };
}

/** A range of a range-diff as named: `old..new`. */
export type ParsedRange = Pick<ModeSpec, 'old' | 'new'>;

/**
 * `git range-diff` style arguments, as two `old..new` ranges:
 *   "a..b" "c..d"  → a..b against c..d
 *   "base" "b" "d" → base..b against base..d
 *   "b...d"        → d..b against b..d: each tip's commits since their divergence
 * A range also takes `<rev>^!`, the one commit. Empty sides default to HEAD; the worktree is
 * not a commit and has no place in a range.
 */
export function parseRangeDiff(args: string[]): [ParsedRange, ParsedRange] {
  if (args.length === 3) {
    const [base, b, d] = args as [string, string, string];
    for (const arg of args)
      if (arg.includes('..') || arg.endsWith('^!'))
        throw new RevspecError('expected <base> <rev1> <rev2> as three plain revisions');
    return [range(base, b), range(base, d)];
  }
  if (args.length === 2) {
    const [a, b] = args as [string, string];
    return [parseRange(a), parseRange(b)];
  }
  if (args.length === 1) {
    const arg = args[0]!;
    const three = arg.indexOf('...');
    if (three === -1 || arg.endsWith('^!'))
      throw new RevspecError('expected <range1> <range2>, <rev1>...<rev2> or <base> <rev1> <rev2>');
    const b = arg.slice(0, three) || 'HEAD';
    const d = arg.slice(three + 3) || 'HEAD';
    if (b.includes('..') || d.includes('..')) throw new RevspecError('cannot combine "..." with ".."');
    return [range(d, b), range(b, d)];
  }
  throw new RevspecError('expected <range1> <range2>, <rev1>...<rev2> or <base> <rev1> <rev2>');
}

function parseRange(arg: string): ParsedRange {
  if (arg.endsWith('^!')) {
    const commit = arg.slice(0, -2) || 'HEAD';
    if (commit.includes('..')) throw new RevspecError('cannot combine "^!" with ".."');
    return range(`${commit}^`, commit);
  }
  if (arg.includes('...')) throw new RevspecError(`a range of a range-diff is <old>..<new>, not ${arg}`);
  const two = arg.indexOf('..');
  if (two === -1) throw new RevspecError(`not a range: ${arg} (expected <old>..<new>)`);
  return range(arg.slice(0, two) || 'HEAD', arg.slice(two + 2) || 'HEAD');
}

function range(old: string, next: string): ParsedRange {
  for (const rev of [old, next])
    if (rev === WORKTREE || rev === `${WORKTREE}^`) throw new RevspecError('the worktree is not a commit');
  return { old, new: next };
}

export class RevspecError extends Error {}
