import {
  type Comparison,
  comparisonLabel,
  MAX_RANGE_COMMITS,
  type ModeSpec,
  type RangeCommit,
  type RangePair,
  type RangeSide,
} from '../shared/protocol.js';
import type { GitRepo } from './git/GitRepo.js';
import { RevspecError } from './revspec.js';

/**
 * The mode that compares `older` with `newer`: `older`'s head replayed onto `newer`'s base against
 * `newer`'s head, so only what the series itself changed in between shows, with the two ranges'
 * commits paired. `range` is where the reviewer continues afterwards; its refs keep being watched,
 * so the comparison is pinned under them. Comments are off in it: the old side is a tree no
 * revision names.
 */
export async function compareRanges(
  repo: GitRepo,
  range: Comparison,
  older: RangeSide,
  newer: RangeSide,
): Promise<ModeSpec> {
  // Two iterations are keyed under their range; named ranges by what they resolved to.
  const commentKey =
    older.iteration != null && newer.iteration != null
      ? `${range.commentKey}:interdiff:${older.iteration}-${newer.iteration}`
      : `range-diff:${older.oldSha}..${older.newSha}:${newer.oldSha}..${newer.newSha}`;
  // The same base needs no replay: the older head's tree is what was reviewed.
  const [{ tree, conflicts }, pairs] = await Promise.all([
    older.oldSha === newer.oldSha
      ? repo.tree(older.newSha).then((tree) => ({ tree, conflicts: [] }))
      : repo.replay(older.oldSha, newer.oldSha, older.newSha),
    pairRanges(repo, older, newer),
  ]);
  return {
    old: tree,
    new: newer.newSha,
    base: 'direct',
    live: range.live === 'none' ? 'none' : 'refs',
    commentKey,
    within: range,
    interdiff: { from: older, to: newer, conflicts, pairs },
  };
}

/**
 * Pairs the two ranges' commits as `git range-diff` does and tells a pair whose patch is the
 * same (a reworded commit) from an amended one by patch id. range-diff compares every commit
 * with every other, so a range past MAX_RANGE_COMMITS is refused rather than left running.
 */
async function pairRanges(repo: GitRepo, older: RangeSide, newer: RangeSide): Promise<RangePair[]> {
  const oldRange = `${older.oldSha}..${older.newSha}`;
  const newRange = `${newer.oldSha}..${newer.newSha}`;
  const [oldCommits, newCommits] = await Promise.all([
    repo.rangeCommits(oldRange, MAX_RANGE_COMMITS),
    repo.rangeCommits(newRange, MAX_RANGE_COMMITS),
  ]);
  for (const [side, commits] of [
    [older, oldCommits],
    [newer, newCommits],
  ] as const)
    if (commits.total > MAX_RANGE_COMMITS)
      throw new RevspecError(
        `${comparisonLabel({ ...side, base: 'direct' })} spans ${commits.total} commits; a range-diff takes at most ${MAX_RANGE_COMMITS}`,
      );
  const rows = await repo.rangeDiff(oldRange, newRange);
  // range-diff abbreviates; a commit beyond the listed window is looked up on its own.
  const find = async (list: RangeCommit[], abbrev: string | null): Promise<RangeCommit | null> => {
    if (abbrev === null) return null;
    const listed = list.find((c) => c.sha.startsWith(abbrev));
    return listed ?? (await repo.rangeCommits(`${abbrev}^!`, 1)).list[0] ?? null;
  };
  const paired = await Promise.all(
    rows.map(async (row) => ({
      old: await find(oldCommits.list, row.old),
      new: await find(newCommits.list, row.new),
      marker: row.marker,
    })),
  );
  const changed = paired.filter((p) => p.marker === '!' && p.old && p.new);
  const ids = await repo.patchIds(changed.flatMap((p) => [p.old!.sha, p.new!.sha]));
  return paired.map(({ old, new: next, marker }) => ({
    old,
    new: next,
    status:
      marker === '='
        ? 'identical'
        : marker === '<'
          ? 'dropped'
          : marker === '>'
            ? 'added'
            : old && next && ids.get(old.sha) !== undefined && ids.get(old.sha) === ids.get(next.sha)
              ? 'message'
              : 'changed',
  }));
}
