//! Read the pull request's inline review threads and its general conversation.
use std::collections::HashSet;
use std::time::Duration;

use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};

use super::{client::GithubClient, pulls::repo_of_pr_url};
use crate::error::GithubError;
use crate::hosted_review::ReviewTarget;
use crate::protocol::{HostedCommentMessage, HostedCommentThread, HostedComments, Side};

const MESSAGE: &str = "id body createdAt url author{login}";
const PERMISSIONS: &str = "state viewerDidAuthor viewerCanDelete viewerCanUpdate";
const PAGE: &str = "pageInfo{hasNextPage endCursor}";
const TIMEOUT: Option<Duration> = Some(Duration::from_secs(15));

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Message {
    id: String,
    body: String,
    created_at: String,
    url: String,
    author: Option<Author>,
    state: Option<String>,
    viewer_did_author: Option<bool>,
    viewer_can_delete: Option<bool>,
    viewer_can_update: Option<bool>,
}

#[derive(Deserialize)]
struct Author {
    login: String,
}

impl From<Message> for HostedCommentMessage {
    fn from(value: Message) -> Self {
        let is_own_pending = value.state.as_deref() == Some("PENDING") && value.viewer_did_author == Some(true);
        Self {
            id: value.id,
            author: value.author.map_or_else(|| "Deleted user".into(), |a| a.login),
            body: value.body,
            created_at: value.created_at,
            url: value.url,
            can_delete: Some(is_own_pending && value.viewer_can_delete == Some(true)),
            can_edit: is_own_pending && value.viewer_can_update == Some(true),
            is_own_pending,
            status: value.state.map(|state| state.to_ascii_lowercase().replace('_', "-")),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Thread {
    id: String,
    pull_request: ThreadRevision,
    path: String,
    line: Option<i64>,
    start_line: Option<i64>,
    original_line: Option<i64>,
    original_start_line: Option<i64>,
    diff_side: DiffSide,
    is_resolved: bool,
    is_outdated: bool,
    viewer_can_reply: bool,
    viewer_can_resolve: bool,
    viewer_can_unresolve: bool,
    replies: Page<Message>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadRevision {
    head_ref_oid: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum DiffSide {
    Left,
    Right,
}

impl Thread {
    fn into_summary(self) -> (HostedCommentThread, PageInfo) {
        let summary = HostedCommentThread {
            id: self.id,
            head_sha: self.pull_request.head_ref_oid,
            path: self.path,
            line: self.line,
            start_line: self.start_line,
            original_line: self.original_line,
            original_start_line: self.original_start_line,
            side: match self.diff_side {
                DiffSide::Left => Side::Old,
                DiffSide::Right => Side::New,
            },
            is_resolved: self.is_resolved,
            is_outdated: self.is_outdated,
            viewer_can_reply: self.viewer_can_reply,
            viewer_can_resolve: self.viewer_can_resolve,
            viewer_can_unresolve: self.viewer_can_unresolve,
            comments: self.replies.nodes.into_iter().flatten().map(Into::into).collect(),
        };
        (summary, self.replies.page_info)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page<T> {
    nodes: Vec<Option<T>>,
    page_info: PageInfo,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
}

struct Pull<'a> {
    client: &'a dyn GithubClient,
    variables: Value,
}

impl Pull<'_> {
    async fn collect<T: DeserializeOwned>(&self, field: &str, fields: &str) -> Result<Vec<T>, GithubError> {
        let query = format!(
            "query($owner:String!,$repo:String!,$number:Int!,$after:String){{repository(owner:$owner,name:$repo){{pullRequest(number:$number){{{field}(first:30,after:$after){{nodes{{{fields}}} {PAGE}}}}}}}}}"
        );
        let pointer = format!("/repository/pullRequest/{field}");
        collect(self.client, &query, self.variables.clone(), &pointer).await
    }

    async fn threads(&self) -> Result<Vec<HostedCommentThread>, GithubError> {
        let fields = format!(
            "id path line startLine originalLine originalStartLine diffSide isResolved isOutdated viewerCanReply viewerCanResolve viewerCanUnresolve pullRequest{{headRefOid}} replies:comments(first:20){{nodes{{{MESSAGE} {PERMISSIONS}}} {PAGE}}}"
        );
        let threads = self.collect::<Thread>("reviewThreads", &fields).await?;
        let reply_query = format!(
            "query($id:ID!,$after:String){{node(id:$id){{... on PullRequestReviewThread{{comments(first:100,after:$after){{nodes{{{MESSAGE} {PERMISSIONS}}} {PAGE}}}}}}}}}"
        );
        let mut result = Vec::with_capacity(threads.len());
        for thread in threads {
            let (mut summary, page) = thread.into_summary();
            if let Some(cursor) = next(&page)? {
                let vars = json!({ "id": summary.id, "after": cursor });
                let more: Vec<Message> = collect(self.client, &reply_query, vars, "/node/comments").await?;
                summary.comments.extend(more.into_iter().map(Into::into));
            }
            result.push(summary);
        }
        Ok(result)
    }
}

pub async fn read(client: &dyn GithubClient, pr: &ReviewTarget) -> Result<HostedComments, GithubError> {
    let (owner, repo) = repo_of_pr_url(&pr.url)?;
    let pull = Pull { client, variables: json!({ "owner": owner, "repo": repo, "number": pr.number }) };
    let review_fields = format!("{MESSAGE} state");
    let (threads, general, reviews) = tokio::try_join!(
        pull.threads(),
        pull.collect::<Message>("comments", MESSAGE),
        pull.collect::<Message>("reviews", &review_fields),
    )?;
    let mut conversation: Vec<HostedCommentMessage> = general
        .into_iter()
        .chain(reviews.into_iter().filter(|review| !review.body.trim().is_empty()))
        .map(Into::into)
        .collect();
    conversation.sort_by(|a, b| (&a.created_at, &a.id).cmp(&(&b.created_at, &b.id)));
    Ok(HostedComments { threads, conversation })
}

async fn collect<T: DeserializeOwned>(
    client: &dyn GithubClient,
    query: &str,
    mut variables: Value,
    pointer: &str,
) -> Result<Vec<T>, GithubError> {
    let mut values = Vec::new();
    let mut seen = HashSet::new();
    if let Some(cursor) = variables["after"].as_str() {
        seen.insert(cursor.to_owned());
    }
    loop {
        let data = client.graphql(query, variables.clone(), TIMEOUT).await?;
        let page = data.pointer(pointer).ok_or_else(|| unreadable("GitHub did not return the comments"))?;
        let page: Page<T> = serde_json::from_value(page.clone())
            .map_err(|error| unreadable(format!("Cannot read GitHub comments: {error}")))?;
        values.extend(page.nodes.into_iter().flatten());
        let Some(cursor) = next(&page.page_info)? else { return Ok(values) };
        if !seen.insert(cursor.to_owned()) {
            return Err(unreadable("GitHub repeated a comments cursor"));
        }
        variables["after"] = json!(cursor);
    }
}

fn next(page: &PageInfo) -> Result<Option<&str>, GithubError> {
    if !page.has_next_page {
        return Ok(None);
    }
    page.end_cursor.as_deref().map(Some).ok_or_else(|| unreadable("GitHub did not return the next comments cursor"))
}

fn unreadable(message: impl Into<String>) -> GithubError {
    GithubError::new(message, 502)
}

/// Authorizes the exact pending comment on this PR before using its REST identifier.
pub async fn pending_comment_id(client: &dyn GithubClient, pr_url: &str, id: &str) -> Result<u64, GithubError> {
    let comment = pending_comment(client, pr_url, id).await?;
    if comment["viewerCanDelete"] != true {
        return Err(GithubError::conflict("You can only delete your own pending comments on this pull request"));
    }
    comment["databaseId"].as_u64().ok_or_else(|| unreadable("GitHub did not return the comment's REST identifier"))
}

pub async fn pending_comment_edit(
    client: &dyn GithubClient,
    pr_url: &str,
    id: &str,
    body: &str,
) -> Result<String, GithubError> {
    let comment = pending_comment(client, pr_url, id).await?;
    if comment["viewerCanUpdate"] != true {
        return Err(GithubError::conflict("GitHub does not allow editing this pending comment"));
    }
    let previous = comment["body"].as_str().ok_or_else(|| unreadable("GitHub did not return the comment body"))?;
    // Export uses the trailing marker to find this draft again at its anchor.
    let marker = previous.trim_end().rsplit_once("\n\n").map(|(_, marker)| marker).filter(|text| {
        text.strip_prefix("<!-- diffle-thread:").and_then(|id| id.strip_suffix(" -->")).is_some_and(|id| {
            !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"%._-*".contains(&byte))
        })
    });
    Ok(match marker {
        Some(marker) => format!("{body}\n\n{marker}"),
        None => body.to_owned(),
    })
}

async fn pending_comment(client: &dyn GithubClient, pr_url: &str, id: &str) -> Result<Value, GithubError> {
    let query = format!(
        "query($id:ID!){{node(id:$id){{... on PullRequestReviewComment{{databaseId body {PERMISSIONS} pullRequest{{url}}}}}}}}"
    );
    let mut data = client.graphql(&query, json!({ "id": id }), TIMEOUT).await?;
    let comment = data["node"].take();
    if comment["state"] != "PENDING" || comment["viewerDidAuthor"] != true || comment["pullRequest"]["url"] != pr_url {
        return Err(GithubError::conflict("You can only change your own pending comments on this pull request"));
    }
    Ok(comment)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTarget {
    pub pull_request: ThreadPull,
    pub is_resolved: bool,
    pub viewer_can_reply: bool,
    pub viewer_can_resolve: bool,
    pub viewer_can_unresolve: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadPull {
    pub url: String,
    pub head_ref_oid: String,
}

pub async fn thread_target(client: &dyn GithubClient, pr_url: &str, id: &str) -> Result<ThreadTarget, GithubError> {
    let query = "query($id:ID!){node(id:$id){... on PullRequestReviewThread{isResolved viewerCanReply viewerCanResolve viewerCanUnresolve pullRequest{url headRefOid}}}}";
    let mut data = client.graphql(query, json!({ "id": id }), TIMEOUT).await?;
    let target: ThreadTarget = serde_json::from_value(data["node"].take())
        .map_err(|error| unreadable(format!("Cannot read GitHub thread: {error}")))?;
    if target.pull_request.url != pr_url {
        return Err(GithubError::conflict("This thread is not on the active pull request"));
    }
    Ok(target)
}

pub async fn reply(client: &dyn GithubClient, id: &str, review_id: &str, body: &str) -> Result<(), GithubError> {
    let mutation = "mutation($input:AddPullRequestReviewThreadReplyInput!){addPullRequestReviewThreadReply(input:$input){comment{id}}}";
    let vars = json!({
        "input": { "pullRequestReviewThreadId": id, "pullRequestReviewId": review_id, "body": body }
    });
    let data = client.graphql(mutation, vars, TIMEOUT).await?;
    if data.pointer("/addPullRequestReviewThreadReply/comment/id").and_then(Value::as_str).is_none() {
        return Err(unreadable("GitHub did not return the added reply"));
    }
    Ok(())
}

pub async fn set_resolved(client: &dyn GithubClient, id: &str, resolved: bool) -> Result<(), GithubError> {
    let (field, input) = if resolved {
        ("resolveReviewThread", "ResolveReviewThreadInput")
    } else {
        ("unresolveReviewThread", "UnresolveReviewThreadInput")
    };
    let mutation = format!("mutation($input:{input}!){{{field}(input:$input){{thread{{isResolved}}}}}}");
    let data = client.graphql(&mutation, json!({ "input": { "threadId": id } }), TIMEOUT).await?;
    if data[field]["thread"]["isResolved"].as_bool() != Some(resolved) {
        return Err(unreadable("GitHub did not confirm the thread's resolution"));
    }
    Ok(())
}
