//! Two series of commits paired as `git range-diff` pairs them, and git's stable patch ids: both
//! built on the commits' diffs, in-process.
use std::collections::HashMap;

use gix::ObjectId;
use gix::bstr::ByteSlice;

use super::assignment::compute_assignment;
use super::hunks;
use super::patch::write_pair;
use super::patch_id::patch_id;
use super::sides::{self, Item, Reader};
use super::{NoDiff, compare, detect_renames, is_binary, unified};
use crate::error::GitError;
use crate::git::GitRepo;
use crate::git::walk::commits_in;

/// `git range-diff` pairs two commits while the diff between their patches costs less than this
/// percentage of a patch's size. Git's default of 60 leaves a reworded three-line commit unpaired,
/// since the message change alone outweighs it; at 100 the message may change as much as the patch.
const CREATION_FACTOR: usize = 100;
/// What range-diff charges for a pairing it rules out.
const COST_MAX: i32 = 1 << 16;

/// One row of a range-diff, none on the side a commit has no counterpart.
pub struct RangeDiffRow {
    pub old: Option<String>,
    pub new: Option<String>,
    /// `=` identical, `!` changed, `<` only in the first range, `>` only in the second.
    pub marker: char,
}

/// A commit's file pair, with both sides' contents unless git would call it binary.
struct Pair {
    old: Option<Item>,
    new: Option<Item>,
    rename: Option<u64>,
    before: Option<Vec<u8>>,
    after: Option<Vec<u8>>,
}

impl GitRepo {
    /// How `git range-diff` pairs the commits of two ranges, in its output order.
    pub async fn range_diff(&self, old_range: &str, new_range: &str) -> Result<Vec<RangeDiffRow>, GitError> {
        let (old_range, new_range, root) = (old_range.to_owned(), new_range.to_owned(), self.root.clone());
        self.gix("range-diff", move |repo| {
            let mut reader = Reader::new(repo, &root)?;
            let mut no_diff = NoDiff::new(repo)?;
            let mut series = |range: &str| -> anyhow::Result<Vec<Text>> {
                let mut commits = commits_in(repo, range)?;
                commits.reverse();
                let mut texts = Vec::new();
                for id in commits {
                    let commit = repo.find_commit(id)?;
                    if commit.parent_ids().count() < 2 {
                        texts.push(Text::new(&commit, &pairs(repo, &mut reader, &mut no_diff, &commit)?)?);
                    }
                }
                Ok(texts)
            };
            let (a, b) = (series(&old_range)?, series(&new_range)?);
            Ok(rows(&a, &b, &correspondences(&a, &b)))
        })
        .await
    }

    /// Each commit's stable patch id, as `git patch-id --stable` gives it, so two commits with the
    /// same change under different messages compare equal. Merges and empty commits have none.
    pub async fn patch_ids(&self, shas: &[String]) -> Result<HashMap<String, String>, GitError> {
        let (shas, root) = (shas.to_vec(), self.root.clone());
        self.gix("patch-id", move |repo| {
            let mut reader = Reader::new(repo, &root)?;
            let mut no_diff = NoDiff::new(repo)?;
            let mut ids = HashMap::new();
            for sha in shas {
                let commit = repo.find_commit(ObjectId::from_hex(sha.as_bytes())?)?;
                if commit.parent_ids().count() > 1 {
                    continue;
                }
                let mut patch = Vec::new();
                for p in pairs(repo, &mut reader, &mut no_diff, &commit)? {
                    write_pair(&mut patch, repo, (p.old.as_ref(), p.new.as_ref()), p.rename, (&p.before, &p.after), 3);
                }
                if let Some(id) = patch_id(&patch) {
                    ids.insert(sha, id);
                }
            }
            Ok(ids)
        })
        .await
    }
}

/// What `git log -p` shows for a commit against its first parent.
fn pairs(
    repo: &gix::Repository,
    reader: &mut Reader<'_>,
    no_diff: &mut NoDiff<'_>,
    commit: &gix::Commit<'_>,
) -> anyhow::Result<Vec<Pair>> {
    let parent = match commit.parent_ids().next() {
        Some(parent) => repo.find_commit(parent)?.tree_id()?.detach(),
        None => ObjectId::empty_tree(repo.object_hash()),
    };
    let old = sides::tree_items(repo, parent)?;
    let new = sides::tree_items(repo, commit.tree_id()?.detach())?;
    let mut changes = compare(old, new, &[]);
    detect_renames(&mut changes, reader);
    let mut out = Vec::new();
    for change in changes {
        let path = &change.new.as_ref().or(change.old.as_ref()).expect("a side").path;
        let unread = no_diff.get(path)?;
        let mut read = |item: Option<&Item>| match item {
            _ if unread => None,
            Some(item) => reader.content(item),
            None => Some(Vec::new()),
        };
        let (mut before, mut after) = (read(change.old.as_ref()), read(change.new.as_ref()));
        if before.as_deref().is_none_or(is_binary) || after.as_deref().is_none_or(is_binary) {
            (before, after) = (None, None);
        }
        out.push(Pair { old: change.old, new: change.new, rename: change.rename, before, after });
    }
    Ok(out)
}

/// A commit as range-diff compares it: its metadata and message, then a section per file.
struct Text {
    id: ObjectId,
    patch: Vec<u8>,
    /// Where the file sections start: commits pair on what follows, not on their messages.
    diff_offset: usize,
    /// Lines in the file sections, which a creation or deletion costs.
    diff_lines: usize,
}

impl Text {
    fn new(commit: &gix::Commit<'_>, pairs: &[Pair]) -> anyhow::Result<Self> {
        let author = commit.author()?.trim();
        let mut patch =
            format!(" ## Metadata ##\nAuthor: {} <{}>\n\n ## Commit message ##\n", author.name, author.email)
                .into_bytes();
        let message = commit.message_raw_sloppy().to_str_lossy().into_owned();
        for line in message.trim_end_matches('\n').split('\n') {
            patch.extend_from_slice(format!("    {line}").trim_end().as_bytes());
            patch.push(b'\n');
        }
        let (mut diff_offset, mut diff_lines) = (0, 0);
        let mut line = |patch: &mut Vec<u8>, text: &[u8]| {
            patch.extend_from_slice(text);
            patch.push(b'\n');
            diff_lines += 1;
        };
        for pair in pairs {
            let split = matches!((&pair.old, &pair.new), (Some(o), Some(n)) if unified::splits(o.mode, n.mode));
            let sections = if split {
                vec![(pair.old.as_ref(), None, &pair.before, &None), (None, pair.new.as_ref(), &None, &pair.after)]
            } else {
                vec![(pair.old.as_ref(), pair.new.as_ref(), &pair.before, &pair.after)]
            };
            for (old, new, before, after) in sections {
                patch.push(b'\n');
                if diff_offset == 0 {
                    diff_offset = patch.len();
                }
                let name = |item: &Item| item.path.to_str_lossy().into_owned();
                let mut header = match (old, new) {
                    (None, Some(n)) => format!("{} (new)", name(n)),
                    (Some(o), None) => format!("{} (deleted)", name(o)),
                    (Some(o), Some(n)) if pair.rename.is_some() => format!("{} => {}", name(o), name(n)),
                    (_, n) => name(n.expect("a side")),
                };
                if let (Some(o), Some(n)) = (old, new)
                    && o.mode != n.mode
                {
                    header += &format!(" (mode change {:06o} => {:06o})", o.mode, n.mode);
                }
                line(&mut patch, format!(" ## {header} ##").as_bytes());
                let file = name(new.or(old).expect("a side"));
                let empty = Vec::new();
                let (before, after) = match (before, after, split) {
                    (Some(b), Some(a), _) => (b, a),
                    (Some(b), None, true) => (b, &empty),
                    (None, Some(a), true) => (&empty, a),
                    _ => {
                        if old.map(|o| o.id) != new.map(|n| n.id) {
                            let label = |item: Option<&Item>| item.map_or_else(|| "/dev/null".to_owned(), name);
                            line(
                                &mut patch,
                                format!(" Binary files {} and {} differ", label(old), label(new)).as_bytes(),
                            );
                        }
                        continue;
                    }
                };
                for hunk in hunks::hunks(before, after, 3, true) {
                    let func = if hunk.func.is_empty() {
                        String::new()
                    } else {
                        format!(" {file}: {}", hunk.func.to_str_lossy())
                    };
                    line(&mut patch, format!("@@{func}").as_bytes());
                    for (prefix, text) in hunk.lines {
                        let mut row = vec![prefix];
                        row.extend_from_slice(text.strip_suffix(b"\n").unwrap_or(text));
                        line(&mut patch, &row);
                        if text.last() != Some(&b'\n') {
                            line(&mut patch, b" \\ No newline at end of file");
                        }
                    }
                }
            }
        }
        Ok(Self { id: commit.id, patch, diff_offset, diff_lines })
    }

    fn diff(&self) -> &[u8] {
        &self.patch[self.diff_offset..]
    }
}

/// Which commit of `b` each commit of `a` pairs with: identical diffs first, then the assignment
/// minimising the size of the diffs between paired diffs, against creating or dropping either.
fn correspondences(a: &[Text], b: &[Text]) -> Vec<Option<usize>> {
    let mut matching_a: Vec<Option<usize>> = vec![None; a.len()];
    let mut matching_b: Vec<Option<usize>> = vec![None; b.len()];
    let mut by_diff: HashMap<&[u8], Vec<usize>> = HashMap::new();
    for (i, text) in a.iter().enumerate() {
        by_diff.entry(text.diff()).or_default().push(i);
    }
    for (j, text) in b.iter().enumerate() {
        // Git's hash map hands back the most recently added of equal entries.
        if let Some(i) = by_diff.get_mut(text.diff()).and_then(Vec::pop) {
            (matching_a[i], matching_b[j]) = (Some(j), Some(i));
        }
    }
    let n = a.len() + b.len();
    let mut cost = vec![0i32; n * n];
    let create =
        |text: &Text, matched: bool| if matched { COST_MAX } else { (text.diff_lines * CREATION_FACTOR / 100) as i32 };
    for (i, ta) in a.iter().enumerate() {
        for (j, tb) in b.iter().enumerate() {
            cost[i + n * j] = match (matching_a[i], matching_b[j]) {
                (Some(m), _) if m == j => 0,
                (None, None) => diff_size(ta.diff(), tb.diff()),
                _ => COST_MAX,
            };
        }
        for j in b.len()..n {
            cost[i + n * j] = create(ta, matching_a[i].is_some());
        }
    }
    for (j, tb) in b.iter().enumerate() {
        for i in a.len()..n {
            cost[i + n * j] = create(tb, matching_b[j].is_some());
        }
    }
    let (a2b, _) = compute_assignment(n, n, &cost);
    (0..a.len()).map(|i| usize::try_from(a2b[i]).ok().filter(|&j| j < b.len())).collect()
}

/// How big the diff between two patches is: its hunks and their lines, with three lines of context.
fn diff_size(a: &[u8], b: &[u8]) -> i32 {
    let hunks = hunks::hunks(a, b, 3, false);
    (hunks.len() + hunks.iter().map(|h| h.lines.len()).sum::<usize>()) as i32
}

/// The rows in range-diff's order: the second range's, with each commit only in the first placed
/// once all of its predecessors were shown.
fn rows(a: &[Text], b: &[Text], a2b: &[Option<usize>]) -> Vec<RangeDiffRow> {
    let mut b2a: Vec<Option<usize>> = vec![None; b.len()];
    for (i, j) in a2b.iter().enumerate() {
        if let Some(j) = j {
            b2a[*j] = Some(i);
        }
    }
    let row = |old: Option<&Text>, new: Option<&Text>| RangeDiffRow {
        old: old.map(|t| t.id.to_string()),
        new: new.map(|t| t.id.to_string()),
        marker: match (old, new) {
            (Some(_), None) => '<',
            (None, Some(_)) => '>',
            (Some(o), Some(n)) if o.patch == n.patch => '=',
            _ => '!',
        },
    };
    let (mut shown, mut out) = (vec![false; a.len()], Vec::new());
    let (mut i, mut j) = (0, 0);
    while i < a.len() || j < b.len() {
        while i < a.len() && shown[i] {
            i += 1;
        }
        if i < a.len() && a2b[i].is_none() {
            out.push(row(Some(&a[i]), None));
            i += 1;
            continue;
        }
        while j < b.len() && b2a[j].is_none() {
            out.push(row(None, Some(&b[j])));
            j += 1;
        }
        if j < b.len() {
            let i = b2a[j].expect("paired");
            out.push(row(Some(&a[i]), Some(&b[j])));
            shown[i] = true;
            j += 1;
        }
    }
    out
}
