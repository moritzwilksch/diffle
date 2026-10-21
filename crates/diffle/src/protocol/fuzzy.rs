//! Ranks workspace symbols; the client filters with the same scoring, so both sides agree on the order.

const MATCH: f64 = 1.0;
const WORD_START: f64 = 8.0;
const FIRST: f64 = 2.0;
const CONSECUTIVE: f64 = 4.0;
const GAP: f64 = 1.0;

/// Score `candidate` against `query`, matched case-insensitively as an ordered subsequence; none
/// when it does not match. Higher is better: matches at word starts (after `_-./`, camelCase
/// humps, digit runs) and unbroken runs count most.
pub fn fuzzy_score(query: &str, candidate: &str) -> Option<f64> {
    let q: Vec<char> = query.chars().flat_map(char::to_lowercase).collect();
    let chars: Vec<char> = candidate.chars().collect();
    let (n, m) = (q.len(), chars.len());
    if n == 0 {
        return Some(0.0);
    }
    if n > m {
        return None;
    }
    let lower: Vec<char> = chars.iter().map(|c| c.to_lowercase().next().unwrap_or(*c)).collect();
    let bonus: Vec<f64> =
        (0..m).map(|j| MATCH + word_start(if j == 0 { None } else { Some(chars[j - 1]) }, chars[j])).collect();
    // prev[j]: best score of the query so far with its last character matched at j.
    let mut prev = vec![f64::NEG_INFINITY; m];
    for (i, &qc) in q.iter().enumerate() {
        let mut cur = vec![f64::NEG_INFINITY; m];
        // Best earlier match k < j, less GAP per character skipped between k and j.
        let mut carry = f64::NEG_INFINITY;
        for j in i..m {
            if i > 0 {
                carry = (carry - GAP).max(prev[j - 1]);
            }
            if lower[j] != qc {
                continue;
            }
            cur[j] = (if i == 0 { 0.0 } else { carry.max(prev[j - 1] + CONSECUTIVE) }) + bonus[j];
        }
        prev = cur;
    }
    let best = prev.into_iter().fold(f64::NEG_INFINITY, f64::max);
    (best != f64::NEG_INFINITY).then_some(best)
}

fn word_start(before: Option<char>, ch: char) -> f64 {
    let Some(before) = before else { return WORD_START + FIRST };
    if !before.is_alphanumeric()
        || (ch.is_uppercase() && !before.is_uppercase())
        || (ch.is_numeric() && !before.is_numeric())
    {
        return WORD_START;
    }
    0.0
}

/// `items` whose `key` matches `query`, best first; ties prefer the shorter key, then input order.
/// A blank query keeps every item in order.
pub fn fuzzy_filter<T: Clone>(items: &[T], query: &str, key: impl Fn(&T) -> &str) -> Vec<T> {
    let q = query.trim();
    if q.is_empty() {
        return items.to_vec();
    }
    let mut scored: Vec<(usize, f64, usize)> = items
        .iter()
        .enumerate()
        .filter_map(|(i, item)| fuzzy_score(q, key(item)).map(|s| (i, s, key(item).chars().count())))
        .collect();
    scored.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.2.cmp(&b.2)).then(a.0.cmp(&b.0)));
    scored.into_iter().map(|(i, _, _)| items[i].clone()).collect()
}

/// `fuzzy_filter`'s order, followed by the items it rejects in input order: re-ranks hits another
/// matcher chose.
pub fn fuzzy_rank<T: Clone>(items: &[T], query: &str, key: impl Fn(&T) -> &str) -> Vec<T> {
    let q = query.trim();
    if q.is_empty() {
        return items.to_vec();
    }
    let mut matched: Vec<(usize, f64, usize)> = Vec::new();
    let mut rest = Vec::new();
    for (i, item) in items.iter().enumerate() {
        match fuzzy_score(q, key(item)) {
            Some(score) => matched.push((i, score, key(item).chars().count())),
            None => rest.push(i),
        }
    }
    matched.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.2.cmp(&b.2)).then(a.0.cmp(&b.0)));
    matched.into_iter().map(|(i, _, _)| i).chain(rest).map(|i| items[i].clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const NAMES: [&str; 9] = [
        "AbstractBuilderFactory",
        "AbstractBaseFormatter",
        "abs_buffer_flush",
        "evaluate_run_cases.py",
        "eval_rules.py",
        "every_cache.py",
        "parse_args",
        "argparse",
        "apply",
    ];

    fn rank(query: &str) -> Vec<&'static str> {
        fuzzy_filter(&NAMES, query, |s| s)
    }

    #[test]
    fn matches_word_start_prefixes_across_camel_case_humps_and_separators() {
        assert_eq!(rank("AbsBuiFa")[0], "AbstractBuilderFactory");
        assert_eq!(rank("evruca")[0], "evaluate_run_cases.py");
        // Every word start counts, whatever the casing; tighter matches win the tie.
        assert_eq!(rank("ABF"), ["abs_buffer_flush", "AbstractBaseFormatter", "AbstractBuilderFactory"]);
    }

    #[test]
    fn ranks_a_prefix_over_a_later_substring_and_both_over_a_scattered_subsequence() {
        assert_eq!(rank("arg"), ["argparse", "parse_args"]);
        assert_eq!(rank("pars"), ["parse_args", "argparse"]);
        assert_eq!(rank("ply"), ["apply"]);
    }

    #[test]
    fn ignores_case_keeps_order_and_rejects_what_is_not_a_subsequence() {
        assert_eq!(rank("absbuifa")[0], "AbstractBuilderFactory");
        assert_eq!(rank("EVRUCA")[0], "evaluate_run_cases.py");
        assert_eq!(fuzzy_score("fab", "AbstractBuilderFactory"), None);
        assert_eq!(fuzzy_score("toolong", "tool"), None);
        assert_eq!(fuzzy_score("", "x"), Some(0.0));
        assert_eq!(rank("  "), NAMES);
    }

    #[test]
    fn fuzzy_rank_reranks_matches_and_keeps_the_rest_after_them() {
        assert_eq!(fuzzy_rank(&["zzz", "parse_args", "argparse"], "arg", |s| s), ["argparse", "parse_args", "zzz"]);
    }
}
