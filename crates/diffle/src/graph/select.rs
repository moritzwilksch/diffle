//! Which changed symbols a graph holds when the change has more than it draws: the most telling
//! ones, so a cap drops tests and private helpers before the code a reviewer came to see.
use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;

use crate::protocol::{GraphNodeStatus, LspSymbol};

/// A changed symbol, and how many changed lines it holds.
#[derive(Debug, Clone)]
pub struct Changed {
    pub symbol: LspSymbol,
    pub status: GraphNodeStatus,
    pub lines: usize,
}

// Test code by the conventions of most ecosystems, as the client's `isTest` tells it.
static TEST_DIR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(^|/)(tests?|__tests__|spec|specs|e2e)/").unwrap());
static TEST_FILE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(^|/)(test_[^/]*|[^/]*_test\.[^/.]+|[^/]*\.(test|spec)\.[^/]+)$").unwrap());

fn is_test(s: &LspSymbol) -> bool {
    TEST_DIR.is_match(&s.path) || TEST_FILE.is_match(&s.path) || s.container.as_deref() == Some("tests")
}

/// A name its language marks private: `_name` (not a `__dunder__`) or `#name`.
fn is_private(name: &str) -> bool {
    name.starts_with('#') || (name.starts_with('_') && !(name.starts_with("__") && name.ends_with("__")))
}

/// Orders `changed` most telling first: source before tests, public names before private ones,
/// then the most changed lines; path and line settle the rest.
pub fn rank(changed: &mut [Changed]) {
    changed.sort_by_cached_key(|c| {
        let s = &c.symbol;
        (is_test(s), is_private(&s.name), Reverse(c.lines), s.path.clone(), s.line)
    });
}

/// Splits ranked `changed` into what a graph of `cap` symbols holds and what it cuts, by whole
/// files, so a file shows all of its changes or none: a file ranks by its most telling symbol, and
/// one too big for the room left is cut while smaller ones after it still fit. Both keep the order.
pub fn keep(changed: Vec<Changed>, cap: usize) -> (Vec<Changed>, Vec<Changed>) {
    let mut sizes: HashMap<&str, usize> = HashMap::new();
    let mut files = Vec::new();
    for c in &changed {
        let n = sizes.entry(&c.symbol.path).or_default();
        if *n == 0 {
            files.push(c.symbol.path.as_str());
        }
        *n += 1;
    }
    let mut room = cap;
    let mut kept = HashSet::new();
    for path in files {
        if sizes[path] <= room {
            room -= sizes[path];
            kept.insert(path.to_owned());
        }
    }
    changed.into_iter().partition(|c| kept.contains(&c.symbol.path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn changed(path: &str, name: &str, line: i64, lines: usize) -> Changed {
        let symbol = LspSymbol {
            name: name.into(),
            kind: 12,
            container: None,
            path: path.into(),
            line,
            start_line: line,
            end_line: line,
            col: 0,
        };
        Changed { symbol, status: GraphNodeStatus::Modified, lines }
    }

    fn names(changed: &[Changed]) -> Vec<&str> {
        changed.iter().map(|c| c.symbol.name.as_str()).collect()
    }

    #[test]
    fn ranks_source_before_tests_public_before_private_then_by_changed_lines() {
        let mut all = vec![
            changed("a.py", "_helper", 1, 50),
            changed("tests/test_a.py", "test_run", 1, 90),
            changed("z.py", "small", 1, 2),
            changed("a.py", "__init__", 9, 4),
            changed("b.py", "big", 1, 30),
            changed("src/a.test.ts", "case", 1, 99),
        ];
        rank(&mut all);
        assert_eq!(names(&all), ["big", "__init__", "small", "_helper", "case", "test_run"]);
    }

    #[test]
    fn keeps_whole_files_by_their_best_symbol_and_fills_the_room_left_with_smaller_ones() {
        let ranked = vec![
            changed("a.py", "a1", 1, 9),
            changed("b.py", "b1", 1, 8),
            changed("b.py", "b2", 5, 7),
            changed("a.py", "a2", 5, 6),
            changed("c.py", "c1", 1, 5),
        ];
        let (kept, cut) = keep(ranked, 3);
        assert_eq!(names(&kept), ["a1", "a2", "c1"]);
        assert_eq!(names(&cut), ["b1", "b2"]);
    }
}
