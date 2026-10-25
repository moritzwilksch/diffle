//! Links to lines on origin's GitHub, judged from local refs only, so a lookup answers at once.
use super::hosts::GithubInstance;
use super::pulls::origin_repository;
use crate::error::Result;
use crate::git::{GitRepo, WORKTREE};
use crate::protocol::{Permalink, PermalinkRequest, Review, Side, Snapshot};

/// The link to `req`'s lines at the commit their side of `snap` shows, or why there is none. That
/// commit must be in origin's repository: reachable from origin's remote-tracking branches, or from
/// the reviewed pull request this run fetched when it lives there. A failed reachability query
/// counts as unpushed, which only withholds the link.
pub async fn permalink(
    repo: &GitRepo,
    snap: &Snapshot,
    instance: &GithubInstance,
    req: &PermalinkRequest,
) -> Result<Permalink> {
    let none = |reason: &str| Ok(Permalink { url: None, reason: Some(reason.to_owned()) });
    if req.version != snap.version {
        return none("The review changed; try again");
    }
    let Some(repository) = origin_repository(repo, instance).await? else {
        return none("No GitHub origin to link to");
    };
    let sha = match req.side {
        Side::Old => &snap.old_sha,
        Side::New => &snap.new_sha,
    };
    if sha == WORKTREE {
        return none("Uncommitted lines have no GitHub link");
    }
    // An interdiff's old side is a replay GitHub never saw.
    if req.side == Side::Old && snap.interdiff.is_some() {
        return none("An interdiff’s old side is not on GitHub");
    }
    let mut prefixes = vec!["refs/remotes/origin".to_owned()];
    if let Review::Range { pr: Some(pr), .. } = &snap.review
        && pr.repository.eq_ignore_ascii_case(&repository)
    {
        prefixes.push(format!("{}/{}", repo.review_refs, pr.number));
    }
    if !repo.reachable_from(sha, &prefixes).await.unwrap_or(false) {
        return none("Not on GitHub: these lines are not in a pushed commit");
    }
    let changed = snap.changed.iter().find(|f| f.path == req.path);
    let path = match (req.side, changed.and_then(|f| f.old_path.as_deref())) {
        (Side::Old, Some(old)) => old,
        _ => &req.path,
    };
    let url = instance.permalink(&repository, sha, path, req.start_line, req.end_line);
    Ok(Permalink { url: Some(url), reason: None })
}
