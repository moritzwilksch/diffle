//! GraphQL operations on the viewer's pending review: find it, read its comments, create it, extend it.
use std::collections::HashMap;

use serde::Serialize;
use serde_json::{Value, json};

use super::client::GithubClient;
use super::pulls::repo_of_pr_url;
use crate::error::GithubError;
use crate::protocol::GithubPullRequest;

/// One comment of a pending review: on a line range (`DraftPullRequestReviewThread`) or, with
/// `subjectType: FILE`, on a whole file, which only an added thread can carry.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewComment {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub side: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_line: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_side: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject_type: Option<&'static str>,
    pub body: String,
}

impl ReviewComment {
    pub fn is_file(&self) -> bool {
        self.subject_type == Some("FILE")
    }

    /// The anchor must still match before an exported thread is rewritten.
    pub fn anchor_key(&self) -> String {
        if self.is_file() {
            return format!("{}\0FILE", self.path);
        }
        let line = self.line.unwrap_or_default();
        format!("{}\0{}\0{}\0{line}", self.path, self.side.unwrap_or("RIGHT"), self.start_line.unwrap_or(line))
    }
}

fn unreadable(message: impl Into<String>) -> GithubError {
    GithubError::new(message, 502)
}

/// The pull request's node id and the viewer's own pending review on it, if any. GitHub hides other
/// people's pending reviews, and the login check makes sure of it: appending to someone else's
/// draft would put our comments in their review.
pub async fn find_pending_review(
    github: &dyn GithubClient,
    pr: &GithubPullRequest,
) -> Result<(String, Option<String>), GithubError> {
    let (owner, repo) = repo_of_pr_url(&pr.url)?;
    let query = "query($owner:String!,$repo:String!,$number:Int!){viewer{login} repository(owner:$owner,name:$repo){pullRequest(number:$number){id reviews(last:20,states:[PENDING]){nodes{id author{login}}}}}}";
    let data = github.graphql(query, json!({ "owner": owner, "repo": repo, "number": pr.number }), None).await?;
    let Some(pull_request_id) = data.pointer("/repository/pullRequest/id").and_then(Value::as_str) else {
        return Err(unreadable(format!("cannot read pull request {} from GitHub", pr.url)));
    };
    let login = data.pointer("/viewer/login").and_then(Value::as_str);
    let nodes = data.pointer("/repository/pullRequest/reviews/nodes").and_then(Value::as_array);
    let pending = nodes.into_iter().flatten().find_map(|node| {
        let id = node.get("id").and_then(Value::as_str)?;
        (login.is_some() && node.pointer("/author/login").and_then(Value::as_str) == login).then(|| id.to_owned())
    });
    Ok((pull_request_id.to_owned(), pending))
}

/// One comment already in the pending review: its node id (to rewrite) and body (to compare).
pub struct PendingComment {
    pub node_id: String,
    pub body: String,
}

/// The pending review's own comments, by anchor. It has to be `reviewThreads`: the only view that
/// reports a pending comment's real position. A failed or incomplete lookup aborts the export:
/// absence is safe to infer only from a complete read.
pub async fn pending_comments(
    github: &dyn GithubClient,
    pr: &GithubPullRequest,
    review_id: &str,
) -> Result<HashMap<String, Vec<PendingComment>>, GithubError> {
    let (owner, repo) = repo_of_pr_url(&pr.url)?;
    let query = "query($owner:String!,$repo:String!,$number:Int!,$after:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{path line startLine diffSide subjectType comments(first:1){nodes{id body pullRequestReview{id}}}}}}}}";
    let mut by: HashMap<String, Vec<PendingComment>> = HashMap::new();
    let mut after: Option<String> = None;
    // Bound API work, but never use a partial map to decide which comments to add.
    for _ in 0..10 {
        let vars = json!({ "owner": owner, "repo": repo, "number": pr.number, "after": after });
        let data = github.graphql(query, vars, None).await?;
        let threads = data.pointer("/repository/pullRequest/reviewThreads");
        let nodes = threads.and_then(|t| t.get("nodes")).and_then(Value::as_array);
        let more = threads.and_then(|t| t.pointer("/pageInfo/hasNextPage")).and_then(Value::as_bool);
        let (Some(nodes), Some(more)) = (nodes, more) else {
            return Err(unreadable("cannot read the complete pending review"));
        };
        for thread in nodes {
            let comment = thread.pointer("/comments/nodes/0");
            let (Some(path), Some(id)) =
                (thread.get("path").and_then(Value::as_str), comment.and_then(|c| c.get("id")).and_then(Value::as_str))
            else {
                continue;
            };
            // Only this pending review's own comments: a submitted comment must not be rewritten.
            if comment.and_then(|c| c.pointer("/pullRequestReview/id")).and_then(Value::as_str) != Some(review_id) {
                continue;
            }
            let Some(key) = pending_key(path, thread) else { continue };
            let body = comment.and_then(|c| c.get("body")).and_then(Value::as_str).unwrap_or_default().to_owned();
            by.entry(key).or_default().push(PendingComment { node_id: id.to_owned(), body });
        }
        if !more {
            return Ok(by);
        }
        let cursor = threads.and_then(|t| t.pointer("/pageInfo/endCursor")).and_then(Value::as_str);
        match cursor {
            Some(cursor) if Some(cursor) != after.as_deref() => after = Some(cursor.to_owned()),
            _ => return Err(unreadable("cannot read the next page of the pending review")),
        }
    }
    Err(unreadable("pending review exceeds the 1000-thread lookup limit; export stopped without changes"))
}

/// The anchor key of a thread already in the review, or none for one GitHub reports without a position.
fn pending_key(path: &str, thread: &Value) -> Option<String> {
    let mut c = ReviewComment {
        path: path.to_owned(),
        line: None,
        side: None,
        start_line: None,
        start_side: None,
        subject_type: None,
        body: String::new(),
    };
    if thread.get("subjectType").and_then(Value::as_str) == Some("FILE") {
        c.subject_type = Some("FILE");
        return Some(c.anchor_key());
    }
    c.line = Some(thread.get("line").and_then(Value::as_i64)?);
    c.side = Some(if thread.get("diffSide").and_then(Value::as_str) == Some("LEFT") { "LEFT" } else { "RIGHT" });
    c.start_line = thread.get("startLine").and_then(Value::as_i64);
    Some(c.anchor_key())
}

/// Rewrites one comment where it already sits in the pending review.
pub async fn update_comment(github: &dyn GithubClient, node_id: &str, body: &str) -> Result<(), GithubError> {
    let mutation = "mutation($input:UpdatePullRequestReviewCommentInput!){updatePullRequestReviewComment(input:$input){pullRequestReviewComment{id}}}";
    github.graphql(mutation, json!({ "input": { "pullRequestReviewCommentId": node_id, "body": body } }), None).await?;
    Ok(())
}

/// No `event` in the input, so GitHub keeps the new review pending with all of its threads.
/// Answers the review's node id, for the comments a new review cannot carry.
pub async fn create_pending_review(
    github: &dyn GithubClient,
    pull_request_id: &str,
    commit_oid: &str,
    threads: &[&ReviewComment],
) -> Result<String, GithubError> {
    let mutation =
        "mutation($input:AddPullRequestReviewInput!){addPullRequestReview(input:$input){pullRequestReview{id}}}";
    let input = json!({ "input": { "pullRequestId": pull_request_id, "commitOID": commit_oid, "threads": threads } });
    let data = github.graphql(mutation, input, None).await?;
    match data.pointer("/addPullRequestReview/pullRequestReview/id").and_then(Value::as_str) {
        Some(id) => Ok(id.to_owned()),
        None => Err(unreadable("GitHub did not return the created review")),
    }
}

/// Appends one thread to the pending review; the only way to extend one, or to place a file comment.
pub async fn add_to_pending_review(
    github: &dyn GithubClient,
    review_id: &str,
    c: &ReviewComment,
) -> Result<(), GithubError> {
    let mutation =
        "mutation($input:AddPullRequestReviewThreadInput!){addPullRequestReviewThread(input:$input){thread{id}}}";
    let mut input = serde_json::to_value(c).expect("comments serialize");
    input["pullRequestReviewId"] = json!(review_id);
    github.graphql(mutation, json!({ "input": input }), None).await?;
    Ok(())
}
