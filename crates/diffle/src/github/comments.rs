//! Read the pull request's inline review threads and its general conversation.
use std::collections::HashSet;
use std::time::Duration;

use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};

use super::{client::GithubClient, pulls::repo_of_pr_url};
use crate::error::GithubError;
use crate::protocol::{GithubCommentMessage, GithubCommentThread, GithubComments, PullRef};

const MESSAGE: &str = "id body createdAt url author{login}";
const PERMISSIONS: &str = "state viewerDidAuthor viewerCanDelete";
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
}

#[derive(Deserialize)]
struct Author {
    login: String,
}

impl From<Message> for GithubCommentMessage {
    fn from(value: Message) -> Self {
        Self {
            id: value.id,
            author: value.author.map_or_else(|| "Deleted user".into(), |a| a.login),
            body: value.body,
            created_at: value.created_at,
            url: value.url,
            can_delete: Some(
                value.state.as_deref() == Some("PENDING")
                    && value.viewer_did_author == Some(true)
                    && value.viewer_can_delete == Some(true),
            ),
            state: value.state,
        }
    }
}

#[derive(Deserialize)]
struct Thread {
    #[serde(flatten)]
    summary: GithubCommentThread,
    replies: Page<Message>,
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

    async fn threads(&self) -> Result<Vec<GithubCommentThread>, GithubError> {
        let fields = format!(
            "id path line startLine originalLine originalStartLine diffSide isResolved isOutdated replies:comments(first:20){{nodes{{{MESSAGE} {PERMISSIONS}}} {PAGE}}}"
        );
        let threads = self.collect::<Thread>("reviewThreads", &fields).await?;
        let reply_query = format!(
            "query($id:ID!,$after:String){{node(id:$id){{... on PullRequestReviewThread{{comments(first:100,after:$after){{nodes{{{MESSAGE} {PERMISSIONS}}} {PAGE}}}}}}}}}"
        );
        let mut result = Vec::with_capacity(threads.len());
        for Thread { mut summary, replies } in threads {
            summary.comments = replies.nodes.into_iter().flatten().map(Into::into).collect();
            if let Some(cursor) = next(&replies.page_info)? {
                let vars = json!({ "id": summary.id, "after": cursor });
                let more: Vec<Message> = collect(self.client, &reply_query, vars, "/node/comments").await?;
                summary.comments.extend(more.into_iter().map(Into::into));
            }
            result.push(summary);
        }
        Ok(result)
    }
}

pub async fn read(client: &dyn GithubClient, pr: &PullRef) -> Result<GithubComments, GithubError> {
    let (owner, repo) = repo_of_pr_url(&pr.url)?;
    let pull = Pull { client, variables: json!({ "owner": owner, "repo": repo, "number": pr.number }) };
    let review_fields = format!("{MESSAGE} state");
    let (threads, general, reviews) = tokio::try_join!(
        pull.threads(),
        pull.collect::<Message>("comments", MESSAGE),
        pull.collect::<Message>("reviews", &review_fields),
    )?;
    let mut conversation: Vec<GithubCommentMessage> = general
        .into_iter()
        .chain(reviews.into_iter().filter(|review| !review.body.trim().is_empty()))
        .map(Into::into)
        .collect();
    conversation.sort_by(|a, b| (&a.created_at, &a.id).cmp(&(&b.created_at, &b.id)));
    Ok(GithubComments { threads, conversation })
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
    let query = "query($id:ID!){node(id:$id){... on PullRequestReviewComment{databaseId state viewerDidAuthor viewerCanDelete pullRequest{url}}}}";
    let data = client.graphql(query, json!({ "id": id }), TIMEOUT).await?;
    let comment = &data["node"];
    if comment["state"] != "PENDING"
        || comment["viewerDidAuthor"] != true
        || comment["viewerCanDelete"] != true
        || comment["pullRequest"]["url"] != pr_url
    {
        return Err(GithubError::conflict("You can only delete your own pending comments on this pull request"));
    }
    comment["databaseId"].as_u64().ok_or_else(|| unreadable("GitHub did not return the comment's REST identifier"))
}
