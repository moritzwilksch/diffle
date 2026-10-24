//! What changed between two sides and the patches showing it, computed in-process the way `git
//! diff -M` does: the same files, renames, line counts and patch text.
mod assignment;
mod hunks;
mod patch;
mod patch_id;
mod rename;
mod series;
pub mod sides;
mod unified;
mod worktree;

use gix::ObjectId;
use gix::bstr::{BString, ByteSlice};

use super::{GitRepo, WORKTREE};
use crate::error::Result;
use crate::protocol::{ChangeStatus, ChangedFile};
use sides::{GITLINK, Item, Reader, kind};
pub use unified::is_binary;

/// A path's two sides; a rename carries its score.
struct Change {
    old: Option<Item>,
    new: Option<Item>,
    rename: Option<u64>,
    unmerged: bool,
}

impl GitRepo {
    /// Changed files between two revs, or a rev and the worktree (untracked files included), with
    /// each side's blob: what git stores or would store for it.
    pub async fn numstat(&self, old: &str, new: &str) -> Result<Vec<ChangedFile>> {
        if old == WORKTREE && new == WORKTREE {
            return Ok(Vec::new());
        }
        let live = old == WORKTREE || new == WORKTREE;
        let untracked = if live { self.untracked().await? } else { Vec::new() };
        // A nested repository is listed as `dir/`; git has no diff for it.
        let untracked: Vec<String> = untracked.into_iter().filter(|p| !p.ends_with('/')).collect();
        let (old, new, root) = (old.to_owned(), new.to_owned(), self.root.clone());
        let files = self
            .gix("diffing", move |repo| {
                // Each side as shown, so line diffs and renames run in the direction git's `-R` runs them.
                let side = |rev: &str| -> anyhow::Result<(Vec<Item>, Vec<BString>)> {
                    if rev != WORKTREE {
                        return Ok((sides::tree_items(repo, tree_id(repo, rev)?)?, Vec::new()));
                    }
                    let (mut items, conflicts) = worktree::worktree_items(repo, &root)?;
                    items.extend(worktree::untracked_items(repo, &root, &untracked)?);
                    items.sort_by(|a, b| a.path.cmp(&b.path));
                    Ok((items, conflicts))
                };
                let ((old, old_conflicts), (new, new_conflicts)) = (side(&old)?, side(&new)?);
                let conflicts = if old_conflicts.is_empty() { new_conflicts } else { old_conflicts };
                let mut reader = Reader::new(repo, &root)?;
                let mut changes = compare(old, new, &conflicts);
                detect_renames(&mut changes, &mut reader);
                let mut no_diff = NoDiff::new(repo)?;
                let mut files: Vec<ChangedFile> = changes
                    .iter()
                    .map(|c| changed_file(c, &mut reader, &mut no_diff))
                    .collect::<anyhow::Result<_>>()?;
                files.sort_by(|a, b| a.path.cmp(&b.path));
                Ok(files)
            })
            .await?;
        Ok(files)
    }
}

/// The tree `rev` names: a commit's, or a tree such as the empty one.
fn tree_id(repo: &gix::Repository, rev: &str) -> anyhow::Result<ObjectId> {
    Ok(repo.rev_parse_single(rev)?.object()?.peel_to_tree()?.id)
}

/// Pairs both sorted lists by path into the changes between them.
fn compare(old: Vec<Item>, new: Vec<Item>, conflicts: &[BString]) -> Vec<Change> {
    let mut changes = Vec::new();
    let (mut old, mut new) = (old.into_iter().peekable(), new.into_iter().peekable());
    let change = |old, new| Change { old, new, rename: None, unmerged: false };
    loop {
        let order = match (old.peek(), new.peek()) {
            (None, None) => break,
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (Some(o), Some(n)) => o.path.cmp(&n.path),
        };
        match order {
            std::cmp::Ordering::Less => changes.push(change(old.next(), None)),
            std::cmp::Ordering::Greater => changes.push(change(None, new.next())),
            std::cmp::Ordering::Equal => {
                let (o, n) = (old.next().expect("peeked"), new.next().expect("peeked"));
                let unmerged = conflicts.binary_search(&n.path).is_ok();
                if o.id != n.id || o.mode != n.mode || unmerged {
                    changes.push(Change { unmerged, ..change(Some(o), Some(n)) });
                }
            }
        }
    }
    changes
}

/// Folds deletions and additions git would call renames into one change each. Untracked files
/// never take part: git's diff does not see them.
fn detect_renames(changes: &mut Vec<Change>, reader: &mut Reader<'_>) {
    let sources: Vec<usize> = (0..changes.len())
        .filter(|&i| changes[i].new.is_none() && changes[i].old.as_ref().is_some_and(|o| !o.untracked))
        .collect();
    let destinations: Vec<usize> = (0..changes.len())
        .filter(|&i| changes[i].old.is_none() && changes[i].new.as_ref().is_some_and(|n| !n.untracked))
        .collect();
    if sources.is_empty() || destinations.is_empty() {
        return;
    }
    let src_items: Vec<Item> = sources.iter().map(|&i| changes[i].old.clone().expect("a deletion")).collect();
    let dst_items: Vec<Item> = destinations.iter().map(|&i| changes[i].new.clone().expect("an addition")).collect();
    let pairs = rename::pairs(&src_items, &dst_items, |item| {
        let content = reader.content(item)?;
        Some(rename::Fingerprint::new(&content, !is_binary(&content)))
    });
    let mut gone = Vec::new();
    for pair in pairs {
        let (s, d) = (sources[pair.src], destinations[pair.dst]);
        changes[d].old = changes[s].old.take();
        changes[d].rename = Some(pair.score);
        gone.push(s);
    }
    gone.sort_unstable();
    for s in gone.into_iter().rev() {
        changes.remove(s);
    }
}

/// Paths whose `diff` attribute is unset (`-diff`, `binary`): git diffs them as binary unread.
pub(in crate::git) struct NoDiff<'repo> {
    stack: gix::AttributeStack<'repo>,
    outcome: gix::attrs::search::Outcome,
}

impl<'repo> NoDiff<'repo> {
    pub(in crate::git) fn new(repo: &'repo gix::Repository) -> anyhow::Result<Self> {
        let index = repo.index_or_empty()?;
        let stack =
            repo.attributes_only(&index, gix::worktree::stack::state::attributes::Source::WorktreeThenIdMapping)?;
        let outcome = stack.selected_attribute_matches(["diff"]);
        Ok(Self { stack, outcome })
    }

    pub(in crate::git) fn get(&mut self, path: &BString) -> anyhow::Result<bool> {
        self.outcome.reset();
        self.stack.at_entry(path.as_bstr(), None)?.matching_attributes(&mut self.outcome);
        Ok(self.outcome.iter_selected().next().is_some_and(|m| m.assignment.state == gix::attrs::StateRef::Unset))
    }
}

fn changed_file(change: &Change, reader: &mut Reader<'_>, no_diff: &mut NoDiff<'_>) -> anyhow::Result<ChangedFile> {
    let (old, new) = (change.old.as_ref(), change.new.as_ref());
    let present = new.or(old).expect("a side");
    let status = match (old, new) {
        _ if change.rename.is_some() => ChangeStatus::R,
        (None, _) => ChangeStatus::A,
        (_, None) => ChangeStatus::D,
        _ if change.unmerged => ChangeStatus::U,
        (Some(o), Some(n)) if kind(o.mode) != kind(n.mode) => ChangeStatus::T,
        _ => ChangeStatus::M,
    };
    let unread = no_diff.get(&present.path)?;
    let read = |reader: &mut Reader<'_>, item: Option<&Item>| match item {
        _ if unread => None,
        Some(item) => reader.content(item),
        None => Some(Vec::new()),
    };
    let (before, after) = (read(reader, old), read(reader, new));
    let (binary, (additions, deletions)) = match (&before, &after) {
        (Some(b), Some(a)) if !is_binary(b) && !is_binary(a) => (false, hunks::line_counts(b, a)),
        _ => (true, (0, 0)),
    };
    let gitlink = [old, new].into_iter().flatten().any(|i| kind(i.mode) == GITLINK);
    Ok(ChangedFile {
        path: present.path.to_string(),
        old_path: change.rename.and(old).map(|o| o.path.to_string()),
        status,
        additions,
        deletions,
        binary,
        blob: new.map_or_else(String::new, |n| n.id.to_string()),
        old_blob: old.map_or_else(String::new, |o| o.id.to_string()),
        generated: false,
        submodule: gitlink.then_some(true),
    })
}
