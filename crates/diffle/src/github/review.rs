//! Threads as a pending GitHub review: built once, then created or merged into the viewer's draft.
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use super::client::GithubClient;
use super::pending_review::{
    ReviewComment, add_to_pending_review, create_pending_review, find_pending_review, pending_comments, update_comment,
};
use crate::comments::anchor::compare_threads;
use crate::error::{GithubError, Result};
use crate::protocol::{
    CommentAnchor, CommentMessage, CommentThread, GithubExportResponse, GithubExportResponseReview,
    GithubExportResponseSkippedItem, GithubPullRequest, Side,
};

pub struct BuiltReview {
    /// Every comment to post, line and file alike, in review order.
    pub comments: Vec<ReviewComment>,
    /// The thread each `comments[i]` came from, so a per-comment outcome can name its thread.
    pub ids: Vec<String>,
    pub skipped: Vec<GithubExportResponseSkippedItem>,
}

fn skip(id: &str, reason: &str) -> GithubExportResponseSkippedItem {
    GithubExportResponseSkippedItem { id: id.to_owned(), reason: reason.to_owned() }
}

/// Threads → the comments of one pending review, one per thread. Stale threads are skipped: their
/// lines no longer sit in the diff, and GitHub would refuse them anyway. With `thread_ids`, only
/// those (resolved included, the user asked for them by hand); without, every unresolved thread.
pub fn build_review(threads: &[CommentThread], thread_ids: Option<&[String]>) -> BuiltReview {
    let mut skipped = Vec::new();
    let mut chosen: Vec<&CommentThread> = match thread_ids {
        Some(ids) => {
            let by_id: HashMap<&str, &CommentThread> = threads.iter().map(|t| (t.id.as_str(), t)).collect();
            ids.iter()
                .filter_map(|id| {
                    let found = by_id.get(id.as_str()).copied();
                    if found.is_none() {
                        skipped.push(skip(id, "unknown thread"));
                    }
                    found
                })
                .collect()
        }
        None => threads.iter().filter(|t| !t.resolved).collect(),
    };
    chosen.sort_by(|a, b| compare_threads(a, b));
    let (mut comments, mut ids) = (Vec::new(), Vec::new());
    for t in chosen {
        if t.stale {
            skipped.push(skip(&t.id, "stale"));
            continue;
        }
        comments.push(to_review_comment(t));
        ids.push(t.id.clone());
    }
    BuiltReview { comments, ids, skipped }
}

fn to_review_comment(t: &CommentThread) -> ReviewComment {
    let body = format_body(&t.messages);
    let mut c = ReviewComment {
        path: String::new(),
        line: None,
        side: None,
        start_line: None,
        start_side: None,
        subject_type: None,
        body,
    };
    match &t.anchor {
        CommentAnchor::File { path } => {
            c.path.clone_from(path);
            c.subject_type = Some("FILE");
        }
        CommentAnchor::Line { path, side, start_line, end_line, .. } => {
            let side = if *side == Side::Old { "LEFT" } else { "RIGHT" };
            c.path.clone_from(path);
            c.line = Some(*end_line);
            c.side = Some(side);
            if start_line != end_line {
                c.start_line = Some(*start_line);
                c.start_side = Some(side);
            }
        }
    }
    c
}

/// Messages joined as markdown. GitHub renders ```suggestion fences itself, so bodies stay verbatim.
pub fn format_body(messages: &[CommentMessage]) -> String {
    messages.iter().map(|m| m.body.trim()).collect::<Vec<_>>().join("\n\n---\n\n")
}

/// The hidden marker that ties a review comment to its thread on a later export.
fn thread_marker(id: &str) -> String {
    let encoded: String = form_urlencoded::byte_serialize(id.as_bytes()).collect::<String>().replace('+', "%20");
    format!("<!-- diffle-thread:{encoded} -->")
}

fn describe(skipped: &[GithubExportResponseSkippedItem]) -> String {
    let mut counts: Vec<(&str, usize)> = Vec::new();
    for s in skipped {
        match counts.iter_mut().find(|(reason, _)| *reason == s.reason) {
            Some((_, n)) => *n += 1,
            None => counts.push((&s.reason, 1)),
        }
    }
    counts.iter().map(|(reason, n)| format!("{n} {reason}")).collect::<Vec<_>>().join(", ")
}

/// Adds the threads to a *pending* review on the pull request, creating the pending review when
/// there is none. The review is never submitted: the human opens the pull request and submits it.
/// Re-exporting finds each thread's hidden marker at its anchor: an identical comment is left
/// alone, an edited one is rewritten where it sits, so exports never stack duplicates.
pub async fn export_to_github(
    github: &dyn GithubClient,
    new_sha: &str,
    pr: &GithubPullRequest,
    threads: &[CommentThread],
    thread_ids: Option<&[String]>,
) -> Result<GithubExportResponse, GithubError> {
    if new_sha == "worktree" {
        return Err(GithubError::conflict("GitHub cannot anchor comments to the worktree"));
    }
    let BuiltReview { mut comments, ids, mut skipped } = build_review(threads, thread_ids);
    if comments.is_empty() {
        let message = if skipped.is_empty() {
            "nothing to post".to_owned()
        } else {
            format!("nothing to post: {}", describe(&skipped))
        };
        return Err(GithubError::new(message, 400));
    }
    for (c, id) in comments.iter_mut().zip(&ids) {
        c.body += &format!("\n\n{}", thread_marker(id));
    }
    let (pull_request_id, pending) = find_pending_review(github, pr).await?;
    let Some(pending) = pending else {
        // The review is created with its line comments in one call; file comments only exist as added threads.
        let lines: Vec<&ReviewComment> = comments.iter().filter(|c| !c.is_file()).collect();
        let created = create_pending_review(github, &pull_request_id, new_sha, &lines).await?;
        for (appended, c) in comments.iter().filter(|c| c.is_file()).enumerate() {
            if let Err(e) = add_to_pending_review(github, &created, c).await {
                let message =
                    format!("created the pending review with {} comments, then {}", lines.len() + appended, e.message);
                return Err(GithubError::new(message, 502));
            }
        }
        let response = GithubExportResponse {
            url: pr.url.clone(),
            posted: comments.len() as i64,
            updated: 0,
            review: GithubExportResponseReview::Created,
            skipped,
        };
        return Ok(response);
    };
    let mut existing: BTreeMap<String, Vec<_>> = pending_comments(github, pr, &pending).await?.into_iter().collect();
    let (mut updated, mut posted) = (0, 0);
    let partial = |updated: i64, posted: i64, e: GithubError| {
        if updated == 0 && posted == 0 {
            return e;
        }
        let message =
            format!("updated {updated} and added {posted} comments in the pending review, then {}", e.message);
        GithubError::new(message, 502)
    };
    let mut add = Vec::new();
    for (c, id) in comments.iter().zip(&ids) {
        let marker = thread_marker(id);
        // An anchor alone cannot tell our thread from another draft on the same lines.
        let at = existing.get_mut(&c.anchor_key());
        let hit = at.and_then(|at| {
            let index = at.iter().position(|p| p.body.trim_end().ends_with(&marker))?;
            Some(at.remove(index))
        });
        let Some(hit) = hit else {
            add.push(c);
            continue;
        };
        if hit.body.trim() == c.body.trim() {
            skipped.push(skip(id, "already in the review"));
            continue;
        }
        update_comment(github, &hit.node_id, &c.body).await.map_err(|e| partial(updated, posted, e))?;
        updated += 1;
    }
    for c in add {
        add_to_pending_review(github, &pending, c).await.map_err(|e| partial(updated, posted, e))?;
        posted += 1;
    }
    Ok(GithubExportResponse {
        url: pr.url.clone(),
        posted,
        updated,
        review: GithubExportResponseReview::Existing,
        skipped,
    })
}

/// What one export works on, gathered fresh inside the export queue.
pub struct ExportInput {
    pub new_sha: String,
    pub pull_request: GithubPullRequest,
    pub threads: Vec<CommentThread>,
    pub thread_ids: Option<Vec<String>>,
    pub github: Arc<dyn GithubClient>,
}

/// Serializes validation and writes so overlapping exports cannot add the same thread twice.
#[derive(Default)]
pub struct GithubExporter {
    turn: tokio::sync::Mutex<()>,
}

impl GithubExporter {
    /// Runs `prepare`, then the export, after every earlier export settled; a failure blocks no later one.
    pub async fn export<Fut>(&self, prepare: impl FnOnce() -> Fut) -> Result<GithubExportResponse>
    where
        Fut: Future<Output = Result<ExportInput>>,
    {
        let _turn = self.turn.lock().await;
        let input = prepare().await?;
        let ids = input.thread_ids.as_deref();
        Ok(export_to_github(input.github.as_ref(), &input.new_sha, &input.pull_request, &input.threads, ids).await?)
    }
}
