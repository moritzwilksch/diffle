import type { ParseDiffOptions } from '@pierre/diffs';

/**
 * How every diff is parsed: a change block stays in git's order, in unified and split views alike,
 * as `git diff` and GitHub show it. The library keys its caches on these options, so every parse,
 * hydration and `CodeView` names this one value.
 */
export const PARSE: ParseDiffOptions = { disableLineMatching: true };
