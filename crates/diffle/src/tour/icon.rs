//! The Lucide icons a tour may name: those the installed lucide-react ships, so the client can load
//! every name the validator accepts.
use std::cmp::Reverse;

/// One name per line, written from lucide-react by `test/scripts/lucide-icons.test.ts`.
const NAMES: &str = include_str!("../../lucide-icons.generated.txt");

/// Why `name` names no Lucide icon, with the closest few names; none when it names one.
pub fn refusal(name: &str) -> Option<String> {
    if NAMES.lines().any(|known| known == name) {
        return None;
    }
    let closest: Vec<String> = closest(name).into_iter().map(|n| format!("`{n}`")).collect();
    Some(format!("{name} is not a Lucide icon; the closest are {}. Find names at lucide.dev/icons", closest.join(", ")))
}

/// The three names nearest `name`: those sharing the most of its words, and of those the ones adding
/// the fewest, then by edit distance.
fn closest(name: &str) -> Vec<&'static str> {
    let words: Vec<&str> = name.split('-').collect();
    let mut ranked: Vec<(Reverse<usize>, usize, usize, &str)> = NAMES
        .lines()
        .map(|known| {
            let (shared, extra): (Vec<&str>, Vec<&str>) = known.split('-').partition(|word| words.contains(word));
            let extra = if shared.is_empty() { 0 } else { extra.len() };
            (Reverse(shared.len()), extra, strsim::levenshtein(name, known), known)
        })
        .collect();
    ranked.sort_unstable();
    ranked.into_iter().take(3).map(|(.., known)| known).collect()
}

#[cfg(test)]
mod tests {
    use super::{closest, refusal};

    #[test]
    fn knows_lucide_names_and_suggests_near_ones() {
        assert_eq!(refusal("database"), None);
        assert_eq!(closest("databse"), ["database", "database-x", "table"]);
        assert_eq!(closest("user-icon"), ["user", "user-cog", "user-pen"]);
    }
}
