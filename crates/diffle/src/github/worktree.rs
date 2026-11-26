//! A review that ends at the worktree, exported onto HEAD: GitHub anchors comments to commits only.
use std::collections::HashMap;

use crate::comments::anchor::relocate;
use crate::comments::hunks::{is_shown, shown_ranges};
use crate::error::Result;
use crate::git::GitRepo;
use crate::protocol::{ChangedFile, CommentAnchor, CommentThread, Side};

/// GitHub's own diff context: a line comment outside its hunks is refused.
const GITHUB_CONTEXT: u32 = 3;

/// Why a thread stays behind: its lines exist only in the worktree, or outside the pull request's diff.
pub const UNCOMMITTED: &str = "on uncommitted changes";

/// Threads re-anchored onto `old..head`, the diff GitHub shows; the ids it cannot place map to
/// why. `old` must be the pull request's merge base, so old-side lines carry over unchanged.
pub async fn onto_head(
    repo: &GitRepo,
    old: &str,
    head: &str,
    threads: Vec<CommentThread>,
) -> Result<(Vec<CommentThread>, HashMap<String, String>)> {
    let files = repo.numstat(old, head).await?;
    let mut unplaced = HashMap::new();
    let mut carried = Vec::with_capacity(threads.len());
    for mut t in threads {
        if !t.stale && !place(repo, old, head, &files, &mut t.anchor).await? {
            unplaced.insert(t.id.clone(), UNCOMMITTED.to_owned());
        }
        carried.push(t);
    }
    Ok((carried, unplaced))
}

/// Moves `anchor` onto the pull request's diff; false when it has no place there.
async fn place(
    repo: &GitRepo,
    old: &str,
    head: &str,
    files: &[ChangedFile],
    anchor: &mut CommentAnchor,
) -> Result<bool> {
    let in_diff = |path: &str| files.iter().find(|f| f.path == path || f.old_path.as_deref() == Some(path));
    match anchor {
        CommentAnchor::Tour { .. } => Ok(true),
        CommentAnchor::File { path } => Ok(in_diff(path).is_some()),
        CommentAnchor::Line { path, side, start_line, end_line, quoted } => {
            let Some(file) = in_diff(path) else { return Ok(false) };
            let patch = repo.patch(old, head, file, GITHUB_CONTEXT).await?;
            let (start, end) = match side {
                // The old side is the merge base on both diffs.
                Side::Old => (*start_line, *end_line),
                Side::New => {
                    let Some(contents) = repo.show(head, &file.path).await? else { return Ok(false) };
                    let contents = String::from_utf8_lossy(&contents);
                    let Some(range) = relocate(*start_line, *end_line, quoted, &contents) else { return Ok(false) };
                    range
                }
            };
            if !is_shown(&shown_ranges(&patch, *side), start, end) {
                return Ok(false);
            }
            (*path, *start_line, *end_line) = (file.path.clone(), start, end);
            Ok(true)
        }
    }
}
