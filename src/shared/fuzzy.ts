const MATCH = 1;
const WORD_START = 8;
const FIRST = 2;
const CONSECUTIVE = 4;
const GAP = 1;

/**
 * Score `candidate` against `query`, matched case-insensitively as an ordered subsequence;
 * null when it does not match. Higher is better: matches at word starts (after `_-./`, camelCase
 * humps, digit runs) and unbroken runs count most, so `AbsBuiFa` finds `AbstractBuilderFactory`
 * and `evruca` finds `evaluate_run_cases.py`.
 */
export function fuzzyScore(query: string, candidate: string): number | null {
  const q = Array.from(query.toLowerCase());
  const chars = Array.from(candidate);
  const n = q.length;
  const m = chars.length;
  if (n === 0) return 0;
  if (n > m) return null;
  const lower = chars.map((ch) => ch.toLowerCase());
  const bonus = chars.map((ch, j) => MATCH + wordStart(chars[j - 1], ch));
  // prev[j]: best score of the query so far with its last character matched at j.
  let prev = new Float64Array(m).fill(-Infinity);
  for (let i = 0; i < n; i++) {
    const cur = new Float64Array(m).fill(-Infinity);
    // Best earlier match k < j, less GAP per character skipped between k and j.
    let carry = -Infinity;
    for (let j = i; j < m; j++) {
      if (i > 0) carry = Math.max(carry - GAP, prev[j - 1]!);
      if (lower[j] !== q[i]) continue;
      cur[j] = (i === 0 ? 0 : Math.max(carry, prev[j - 1]! + CONSECUTIVE)) + bonus[j]!;
    }
    prev = cur;
  }
  const best = Math.max(...prev);
  return best === -Infinity ? null : best;
}

function wordStart(before: string | undefined, ch: string): number {
  if (before === undefined) return WORD_START + FIRST;
  if (!ALNUM.test(before)) return WORD_START;
  if (UPPER.test(ch) && !UPPER.test(before)) return WORD_START;
  if (DIGIT.test(ch) && !DIGIT.test(before)) return WORD_START;
  return 0;
}

const ALNUM = /[\p{L}\p{N}]/u;
const UPPER = /\p{Lu}/u;
const DIGIT = /\p{N}/u;

/**
 * `items` whose `key` matches `query`, best first; ties prefer the shorter key, then input order.
 * A blank query keeps every item in order.
 */
export function fuzzyFilter<T>(items: readonly T[], query: string, key: (item: T) => string): T[] {
  const q = query.trim();
  if (!q) return [...items];
  const scored: { item: T; score: number; length: number }[] = [];
  for (const item of items) {
    const k = key(item);
    const score = fuzzyScore(q, k);
    if (score !== null) scored.push({ item, score, length: k.length });
  }
  return scored.sort((a, b) => b.score - a.score || a.length - b.length).map((s) => s.item);
}

/** `fuzzyFilter`'s order, followed by the items it rejects in input order: re-ranks hits another matcher chose. */
export function fuzzyRank<T>(items: readonly T[], query: string, key: (item: T) => string): T[] {
  const matched = fuzzyFilter(items, query, key);
  const kept = new Set(matched);
  return [...matched, ...items.filter((item) => !kept.has(item))];
}
