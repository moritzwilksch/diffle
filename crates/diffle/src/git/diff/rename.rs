//! Rename detection as `git diff -M` does it: exact matches first, then unique basenames, then the
//! best-scoring pairs, scored by git's span-hash estimate of how much of one file the other copies.
use std::collections::HashMap;

use gix::bstr::ByteSlice;

use super::sides::{FILE, Item, kind};

/// Git's similarity scale; a rename needs half of it.
pub const MAX_SCORE: u64 = 60_000;
const MIN_SCORE: u64 = MAX_SCORE / 2;
/// A unique basename pairs at a lower bar than an arbitrary candidate would need.
const MIN_BASENAME_SCORE: u64 = MIN_SCORE + (MAX_SCORE - MIN_SCORE) / 2;
/// Git's `diff.renameLimit`: past this many sources times destinations, only exact renames count.
const RENAME_LIMIT: usize = 1000;
const CANDIDATES_PER_DESTINATION: usize = 4;
const HASHBASE: u32 = 107_927;

/// How much of each span hash a file holds, by bytes: `diffcore-delta`'s fingerprint.
pub struct Fingerprint {
    size: u64,
    spans: HashMap<u32, u64>,
}

impl Fingerprint {
    /// Spans end at a newline or after 64 bytes; in text, a CR before LF is skipped. As in git, the
    /// bytes after the last full span count for nothing.
    pub fn new(content: &[u8], text: bool) -> Self {
        let mut spans = HashMap::new();
        let (mut accum1, mut accum2, mut n) = (0u32, 0u32, 0u64);
        let mut add = |accum1: u32, accum2: u32, n: u64| {
            let hash = accum1.wrapping_add(accum2.wrapping_mul(0x61)) % HASHBASE;
            *spans.entry(hash).or_insert(0) += n;
        };
        for (i, &c) in content.iter().enumerate() {
            if text && c == b'\r' && content.get(i + 1) == Some(&b'\n') {
                continue;
            }
            let old1 = accum1;
            accum1 = (accum1 << 7) ^ (accum2 >> 25);
            accum2 = (accum2 << 7) ^ (old1 >> 25);
            accum1 = accum1.wrapping_add(u32::from(c));
            n += 1;
            if n < 64 && c != b'\n' {
                continue;
            }
            add(accum1, accum2, n);
            (accum1, accum2, n) = (0, 0, 0);
        }
        Self { size: content.len() as u64, spans }
    }
}

/// How similar `dst` is to `src` on git's scale: the bytes it copies over the larger size. Files
/// whose sizes differ too much to reach the bar are not compared.
pub fn score(src: &Fingerprint, dst: &Fingerprint) -> u64 {
    let max = src.size.max(dst.size);
    let delta = max - src.size.min(dst.size);
    if max * (MAX_SCORE - MIN_SCORE) < delta * MAX_SCORE || dst.size == 0 {
        return 0;
    }
    let copied: u64 = src.spans.iter().map(|(hash, &n)| n.min(dst.spans.get(hash).copied().unwrap_or(0))).sum();
    copied * MAX_SCORE / max
}

/// A rename found: indices into the sources and destinations, and its score.
pub struct Pair {
    pub src: usize,
    pub dst: usize,
    pub score: u64,
}

/// Pairs deleted `sources` with added `destinations`. `fingerprint` reads one side's content,
/// none when it is binary-unreadable or too large; only regular files pair inexactly.
pub fn pairs(
    sources: &[Item],
    destinations: &[Item],
    mut fingerprint: impl FnMut(&Item) -> Option<Fingerprint>,
) -> Vec<Pair> {
    let mut found = Vec::new();
    let (mut src_used, mut dst_used) = (vec![false; sources.len()], vec![false; destinations.len()]);
    // Exact: the same blob, a source of the same basename preferred.
    let mut by_id: HashMap<_, Vec<usize>> = HashMap::new();
    for (i, src) in sources.iter().enumerate() {
        by_id.entry(src.id).or_default().push(i);
    }
    for (d, dst) in destinations.iter().enumerate() {
        let Some(candidates) = by_id.get(&dst.id) else { continue };
        // Anything but two regular files pairs only with an identical mode.
        let fits = |&&s: &&usize| {
            let src = &sources[s];
            !src_used[s] && ((regular(src) && regular(dst)) || src.mode == dst.mode)
        };
        let best = candidates.iter().filter(fits).max_by_key(|&&s| (same_basename(&sources[s], dst), Reverse(s)));
        if let Some(&s) = best {
            (src_used[s], dst_used[d]) = (true, true);
            found.push(Pair { src: s, dst: d, score: MAX_SCORE });
        }
    }
    let mut src_prints: Vec<Option<Option<Fingerprint>>> = (0..sources.len()).map(|_| None).collect();
    let mut dst_prints: Vec<Option<Option<Fingerprint>>> = (0..destinations.len()).map(|_| None).collect();
    let mut print = |prints: &mut Vec<Option<Option<Fingerprint>>>, items: &[Item], i: usize| {
        let item = &items[i];
        prints[i].get_or_insert_with(|| if regular(item) { fingerprint(item) } else { None }).is_some()
    };
    let scored = |src: &Option<Option<Fingerprint>>, dst: &Option<Option<Fingerprint>>| match (src, dst) {
        (Some(Some(src)), Some(Some(dst))) => score(src, dst),
        _ => 0,
    };
    // Unique basenames on both sides pair when similar enough.
    fn basenames<'a>(items: &'a [Item], used: &[bool]) -> HashMap<&'a [u8], usize> {
        let mut count: HashMap<&[u8], (usize, usize)> = HashMap::new();
        for (i, item) in items.iter().enumerate().filter(|(i, _)| !used[*i]) {
            count.entry(basename(item)).or_insert((0, i)).0 += 1;
        }
        count.into_iter().filter(|(_, (n, _))| *n == 1).map(|(name, (_, i))| (name, i)).collect()
    }
    let (src_names, dst_names) = (basenames(sources, &src_used), basenames(destinations, &dst_used));
    let mut by_name: Vec<(usize, usize)> =
        dst_names.iter().filter_map(|(name, &d)| src_names.get(name).map(|&s| (s, d))).collect();
    by_name.sort_by_key(|&(_, d)| d);
    for (s, d) in by_name {
        if !(print(&mut src_prints, sources, s) && print(&mut dst_prints, destinations, d)) {
            continue;
        }
        let score = scored(&src_prints[s], &dst_prints[d]);
        if score >= MIN_BASENAME_SCORE {
            (src_used[s], dst_used[d]) = (true, true);
            found.push(Pair { src: s, dst: d, score });
        }
    }
    // Everything else: each destination's best candidates, then the best pairs first.
    let open_src: Vec<usize> = (0..sources.len()).filter(|&s| !src_used[s]).collect();
    let open_dst: Vec<usize> = (0..destinations.len()).filter(|&d| !dst_used[d]).collect();
    if open_src.is_empty() || open_dst.is_empty() || open_src.len() * open_dst.len() > RENAME_LIMIT * RENAME_LIMIT {
        return found;
    }
    // Git keeps each destination's best candidates in four slots, replacing the worst in place;
    // the slots' order then breaks ties in the stable global sort.
    let mut matrix: Vec<(u64, bool, usize, usize)> = Vec::new();
    for &d in &open_dst {
        let mut slots: [Option<(u64, bool, usize)>; CANDIDATES_PER_DESTINATION] = [None; CANDIDATES_PER_DESTINATION];
        if print(&mut dst_prints, destinations, d) {
            for &s in &open_src {
                if !print(&mut src_prints, sources, s) {
                    continue;
                }
                let candidate =
                    (scored(&src_prints[s], &dst_prints[d]), same_basename(&sources[s], &destinations[d]), s);
                let rank = |slot: &Option<(u64, bool, usize)>| slot.map(|(score, name, _)| (score, name));
                let worst = (0..slots.len()).fold(0, |w, i| if rank(&slots[i]) < rank(&slots[w]) { i } else { w });
                if rank(&slots[worst]) < rank(&Some(candidate)) {
                    slots[worst] = Some(candidate);
                }
            }
        }
        matrix.extend(
            slots.into_iter().flatten().filter(|c| c.0 >= MIN_SCORE).map(|(score, name, s)| (score, name, s, d)),
        );
    }
    matrix.sort_by_key(|&(score, name, _, _)| Reverse((score, name)));
    for (score, _, s, d) in matrix {
        if !src_used[s] && !dst_used[d] {
            (src_used[s], dst_used[d]) = (true, true);
            found.push(Pair { src: s, dst: d, score });
        }
    }
    found
}

use std::cmp::Reverse;

fn regular(item: &Item) -> bool {
    kind(item.mode) == kind(FILE)
}

fn basename(item: &Item) -> &[u8] {
    item.path.rsplit_str("/").next().unwrap_or_default()
}

fn same_basename(a: &Item, b: &Item) -> bool {
    basename(a) == basename(b)
}
