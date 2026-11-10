//! What changed between two sides and the patches showing it, computed in-process the way `git
//! diff -M` does: the same files, renames, line counts and patch text.
mod hunks;
mod patch;
mod patch_id;
mod series;
pub mod sides;
mod unified;
mod worktree;

use gix::ObjectId;
use gix::bstr::BString;

use super::{GitRepo, WORKTREE};
use crate::error::Result;
use crate::protocol::{ChangeStatus, ChangedFile};
use gix::diff::blob::ResourceKind;
use sides::{Contents, GITLINK, Item, kind};
pub use unified::is_binary;

/// A path's two sides, or a rename's.
struct Change {
    old: Option<Item>,
    new: Option<Item>,
    rename: bool,
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
                let mut changes = if live {
                    let ((old, old_conflicts), (new, new_conflicts)) = (side(&old)?, side(&new)?);
                    let conflicts = if old_conflicts.is_empty() { new_conflicts } else { old_conflicts };
                    compare(old, new, &conflicts)
                } else {
                    // Two commits: a tree diff, which skips the subtrees they share.
                    pair(sides::tree_diff(repo, tree_id(repo, &old)?, tree_id(repo, &new)?)?)
                };
                let mut contents = Contents::new(repo, &root, live_side(&old, &new))?;
                detect_renames(&mut changes, &mut contents);
                let mut files: Vec<ChangedFile> = changes.iter().map(|c| changed_file(c, &mut contents)).collect();
                files.sort_by(|a, b| a.path.cmp(&b.path));
                Ok(files)
            })
            .await?;
        Ok(files)
    }
}

/// The side of a comparison that is the worktree, if one is.
fn live_side(old: &str, new: &str) -> Option<ResourceKind> {
    match (old == WORKTREE, new == WORKTREE) {
        (true, _) => Some(ResourceKind::OldOrSource),
        (_, true) => Some(ResourceKind::NewOrDestination),
        _ => None,
    }
}

/// The tree `rev` names: a commit's, or a tree such as the empty one.
fn tree_id(repo: &gix::Repository, rev: &str) -> anyhow::Result<ObjectId> {
    Ok(repo.rev_parse_single(rev)?.object()?.peel_to_tree()?.id)
}

/// A path whose entry differs between two sides: either side absent where the path is.
pub(in crate::git) type PathChange = (Option<Item>, Option<Item>);

/// What differs between two trees, path by path, as a checkout from one to the other sees it:
/// no renames.
pub(in crate::git) fn tree_changes(
    repo: &gix::Repository,
    old: ObjectId,
    new: ObjectId,
) -> anyhow::Result<Vec<PathChange>> {
    sides::tree_diff(repo, old, new)
}

fn pair(changes: Vec<PathChange>) -> Vec<Change> {
    changes.into_iter().map(|(old, new)| Change { old, new, rename: false, unmerged: false }).collect()
}

/// Pairs both sorted lists by path into the changes between them.
fn compare(old: Vec<Item>, new: Vec<Item>, conflicts: &[BString]) -> Vec<Change> {
    let mut changes = Vec::new();
    let (mut old, mut new) = (old.into_iter().peekable(), new.into_iter().peekable());
    let change = |old, new| Change { old, new, rename: false, unmerged: false };
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

/// Folds deletions and additions gix's rename tracker pairs into one change each. Untracked files
/// never take part, as git's diff does not see them, nor do unreadable ones. Detection is a
/// nicety: a side the tracker cannot read leaves the pair a deletion and an addition.
fn detect_renames(changes: &mut Vec<Change>, contents: &mut Contents<'_>) {
    let candidate = |item: &Option<Item>| item.as_ref().filter(|i| !i.untracked && !i.id.is_null()).cloned();
    let candidates = changes
        .iter()
        .enumerate()
        .filter_map(|(i, c)| match (&c.old, &c.new) {
            (old, None) => Some((candidate(old)?, ResourceKind::OldOrSource, i)),
            (None, new) => Some((candidate(new)?, ResourceKind::NewOrDestination, i)),
            _ => None,
        })
        .collect();
    let mut gone = Vec::new();
    for (s, d) in contents.renames(candidates).unwrap_or_default() {
        changes[d].old = changes[s].old.take();
        changes[d].rename = true;
        gone.push(s);
    }
    gone.sort_unstable();
    for s in gone.into_iter().rev() {
        changes.remove(s);
    }
}

/// A side's blob as the snapshot names it: empty where the side is absent or could not be read.
fn blob(item: Option<&Item>) -> String {
    item.filter(|i| !i.id.is_null()).map_or_else(String::new, |i| i.id.to_string())
}

fn changed_file(change: &Change, contents: &mut Contents<'_>) -> ChangedFile {
    let (old, new) = (change.old.as_ref(), change.new.as_ref());
    let present = new.or(old).expect("a side");
    let status = match (old, new) {
        _ if change.rename => ChangeStatus::R,
        (None, _) => ChangeStatus::A,
        (_, None) => ChangeStatus::D,
        _ if change.unmerged => ChangeStatus::U,
        (Some(o), Some(n)) if kind(o.mode) != kind(n.mode) => ChangeStatus::T,
        _ => ChangeStatus::M,
    };
    let (binary, (additions, deletions)) = match contents.pair(old, new) {
        (Some(b), Some(a)) => (false, hunks::line_counts(&b, &a)),
        _ => (true, (0, 0)),
    };
    let gitlink = [old, new].into_iter().flatten().any(|i| kind(i.mode) == GITLINK);
    ChangedFile {
        path: present.path.to_string(),
        old_path: change.rename.then(|| old.map(|o| o.path.to_string())).flatten(),
        status,
        additions,
        deletions,
        binary,
        blob: blob(new),
        old_blob: blob(old),
        generated: false,
        submodule: gitlink.then_some(true),
    }
}
