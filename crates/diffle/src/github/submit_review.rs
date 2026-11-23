//! Submits the viewer's draft or sends a standalone review on the reviewed commit.
use serde_json::json;

use super::client::GithubClient;
use crate::error::GithubError;
use crate::protocol::{HostedReviewDecision, HostedReviewSubmit};

pub(crate) async fn submit_review(
    client: &dyn GithubClient,
    pr_id: &str,
    pending: Option<&str>,
    commit_sha: &str,
    request: &HostedReviewSubmit,
) -> Result<(), GithubError> {
    let summary = request.summary.trim();
    let event = match request.decision {
        HostedReviewDecision::Comment if summary.is_empty() && pending.is_none() => {
            return Err(GithubError::new("Write a general comment or add a pending GitHub comment", 400));
        }
        HostedReviewDecision::RequestChanges if summary.is_empty() => {
            return Err(GithubError::new("Explain the changes you are requesting", 400));
        }
        HostedReviewDecision::Comment => "COMMENT",
        HostedReviewDecision::Approve => "APPROVE",
        HostedReviewDecision::RequestChanges => "REQUEST_CHANGES",
    };
    let body = (!summary.is_empty()).then_some(summary);
    let (query, variables, result) = match pending {
        Some(review_id) => (
            "mutation($input:SubmitPullRequestReviewInput!){submitPullRequestReview(input:$input){pullRequestReview{id}}}",
            json!({ "input": { "pullRequestReviewId": review_id, "event": event, "body": body } }),
            "/submitPullRequestReview/pullRequestReview/id",
        ),
        None => (
            "mutation($input:AddPullRequestReviewInput!){addPullRequestReview(input:$input){pullRequestReview{id}}}",
            json!({ "input": { "pullRequestId": pr_id, "commitOID": commit_sha, "event": event, "body": body } }),
            "/addPullRequestReview/pullRequestReview/id",
        ),
    };
    let data = client.graphql(query, variables, None).await?;
    if data.pointer(result).and_then(serde_json::Value::as_str).is_none() {
        return Err(GithubError::new("GitHub did not confirm the submitted review", 502));
    }
    Ok(())
}
