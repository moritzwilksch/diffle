//! Naming pull requests: by number, url, branch, or the checked-out branch's.
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use serde_json::{Value, json};

use super::client::GithubClient;
use super::hosts::{GithubInstance, github_repository};
use crate::error::{GithubError, Result};
use crate::git::GitRepo;

/// A pull request as GitHub reports it, with the base repository read from its url.
#[derive(Clone, Debug)]
pub struct PullRequest {
    pub repository: String,
    pub number: i64,
    pub url: String,
    pub title: String,
    /// `OPEN`, `CLOSED` or `MERGED`.
    pub state: String,
    pub is_draft: bool,
    pub base_ref_oid: String,
    pub base_ref_name: String,
    pub head_ref_name: String,
    pub head_ref_oid: String,
    /// Source repository; none when GitHub no longer exposes the deleted fork.
    pub head_repository: Option<String>,
}

const PR_FIELDS: &str =
    "number url title state isDraft baseRefOid baseRefName headRefName headRefOid headRepository{name owner{login}}";

static PR_URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^https?://([^/?#]+)/([^/]+)/([^/]+)/pull/(\d+)(?:[/?#]|$)").unwrap());
static NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^#?(\d+)$").unwrap());

fn bad(message: impl Into<String>) -> GithubError {
    GithubError::new(message, 400)
}

/// Local-only origin identity; works without a token or a network connection.
pub async fn origin_repository(repo: &GitRepo, instance: &GithubInstance) -> Result<Option<String>> {
    let remotes = repo.remotes().await?;
    Ok(remotes.iter().find(|r| r.name == "origin").and_then(|r| github_repository(&r.url, instance)))
}

/// The repository pull requests are looked up in: `origin`, or the only GitHub remote when origin
/// is not one. Any other layout has to name the pull request by url.
async fn base_repository(repo: Option<&GitRepo>, instance: &GithubInstance) -> Result<String> {
    let Some(repo) = repo else { return Err(bad("not in a git repository; name the pull request by url").into()) };
    let remotes: Vec<(String, String)> = repo
        .remotes()
        .await?
        .into_iter()
        .filter_map(|r| github_repository(&r.url, instance).map(|repository| (r.name, repository)))
        .collect();
    let base =
        remotes.iter().find(|(name, _)| name == "origin").or(if remotes.len() == 1 { remotes.first() } else { None });
    match base {
        Some((_, repository)) => Ok(repository.clone()),
        None if remotes.is_empty() => {
            Err(bad(format!("no remote on {}; name the pull request by url", instance.host)).into())
        }
        None => {
            Err(bad(format!("{} GitHub remotes and no origin; name the pull request by url", remotes.len())).into())
        }
    }
}

/// The host, owner, repository and number of a pull request url.
fn parse_pr_url(url: &str) -> Option<(String, String, String, i64)> {
    let m = PR_URL.captures(url)?;
    let host = m[1].rsplit_once('@').map_or(&m[1], |(_, h)| h).to_lowercase();
    Some((host, m[2].to_owned(), m[3].to_owned(), m[4].parse().ok()?))
}

/// The base repository a pull request lives in, from its url (a fork's own remote is not it).
pub fn repo_of_pr_url(url: &str) -> Result<(String, String), GithubError> {
    let (_, owner, repo, _) = parse_pr_url(url)
        .ok_or_else(|| GithubError::new(format!("cannot read owner/repo from the pull request url: {url}"), 502))?;
    Ok((owner, repo))
}

/// The pull request a selector names: a number, `#number`, a url, a branch (`owner:branch` for a
/// fork's), or, without one, the checked-out branch's. Everything but a url is looked up in the
/// base repository. Option-shaped selectors are refused.
pub async fn view_pr(
    selector: Option<&str>,
    repo: Option<&GitRepo>,
    github: &dyn GithubClient,
    instance: &GithubInstance,
    timeout: Option<Duration>,
) -> Result<PullRequest> {
    let Some(selector) = selector else {
        let Some(repo) = repo else { return Err(bad("not in a git repository; name the pull request by url").into()) };
        let branch = repo.branch_ref("HEAD").await?;
        let Some(branch) = branch.as_deref().and_then(|r| r.strip_prefix("refs/heads/")) else {
            return Err(bad("HEAD is not on a branch; name the pull request by number or url").into());
        };
        let upstream = repo.upstream_branch("HEAD").await?;
        let remotes = repo.remotes().await?;
        let head_repo = upstream
            .as_ref()
            .and_then(|u| remotes.iter().find(|r| r.name == u.remote))
            .and_then(|r| github_repository(&r.url, instance));
        let owner = head_repo.as_deref().and_then(|h| h.split('/').next());
        let head = upstream.as_ref().map_or(branch, |u| u.branch.as_str());
        return by_head(github, &base_repository(Some(repo), instance).await?, head, owner, timeout).await;
    };
    let s = selector.trim();
    if s.starts_with('-') {
        return Err(bad(format!("not a pull request: {selector}")).into());
    }
    let is_url = s.to_lowercase().starts_with("http://") || s.to_lowercase().starts_with("https://");
    if is_url {
        let Some((host, owner, name, number)) = parse_pr_url(s) else {
            return Err(bad(format!("not a pull request url: {selector}")).into());
        };
        if !instance.git_hosts.contains(&host) {
            return Err(bad(format!("{selector} is on {host}, but diffle is talking to {}", instance.host)).into());
        }
        return by_number(github, &format!("{owner}/{name}"), number, timeout).await;
    }
    if let Some(m) = NUMBER.captures(s) {
        let number = m[1].parse().map_err(|_| bad(format!("not a pull request: {selector}")))?;
        return by_number(github, &base_repository(repo, instance).await?, number, timeout).await;
    }
    let (owner, head) = match s.split_once(':') {
        Some((owner, head)) if !owner.is_empty() => (Some(owner), head),
        _ => (None, s),
    };
    by_head(github, &base_repository(repo, instance).await?, head, owner, timeout).await
}

async fn by_number(
    github: &dyn GithubClient,
    repository: &str,
    number: i64,
    timeout: Option<Duration>,
) -> Result<PullRequest> {
    let (owner, repo) = repository.split_once('/').unwrap_or((repository, ""));
    let query = format!(
        "query($owner:String!,$repo:String!,$number:Int!){{repository(owner:$owner,name:$repo){{pullRequest(number:$number){{{PR_FIELDS}}}}}}}"
    );
    let data = github.graphql(&query, json!({ "owner": owner, "repo": repo, "number": number }), timeout).await?;
    match data.pointer("/repository/pullRequest").filter(|v| !v.is_null()) {
        Some(node) => Ok(parse_pull_request(node)?),
        None => Err(GithubError::conflict(format!("no pull request {repository}#{number}")).into()),
    }
}

async fn by_head(
    github: &dyn GithubClient,
    base_repo: &str,
    head: &str,
    owner: Option<&str>,
    timeout: Option<Duration>,
) -> Result<PullRequest> {
    let label = owner.map_or_else(|| head.to_owned(), |o| format!("{o}:{head}"));
    let mut prs: Vec<PullRequest> = pull_requests_for_head(github, base_repo, head, None, timeout)
        .await?
        .into_iter()
        .filter(|pr| {
            owner.is_none_or(|o| {
                pr.head_repository
                    .as_deref()
                    .and_then(|h| h.split('/').next())
                    .is_some_and(|h| h.eq_ignore_ascii_case(o))
            })
        })
        .collect();
    match prs.len() {
        0 => Err(GithubError::conflict(format!("no open pull request in {base_repo} for {label}")).into()),
        1 => Ok(prs.remove(0)),
        n => {
            Err(GithubError::conflict(format!("{n} open pull requests in {base_repo} for {label}; open one by number"))
                .into())
        }
    }
}

/// Open pull requests of `base_repo` whose head is the named branch, from any head repository,
/// into `base` if given.
pub async fn pull_requests_for_head(
    github: &dyn GithubClient,
    base_repo: &str,
    head: &str,
    base: Option<&str>,
    timeout: Option<Duration>,
) -> Result<Vec<PullRequest>, GithubError> {
    let (owner, repo) = base_repo.split_once('/').unwrap_or((base_repo, ""));
    let query = format!(
        "query($owner:String!,$repo:String!,$head:String!,$base:String){{repository(owner:$owner,name:$repo){{pullRequests(headRefName:$head,baseRefName:$base,states:[OPEN],first:100){{nodes{{{PR_FIELDS}}}}}}}}}"
    );
    let vars = json!({ "owner": owner, "repo": repo, "head": head, "base": base });
    let data = github.graphql(&query, vars, timeout).await?;
    let Some(nodes) = data.pointer("/repository/pullRequests/nodes").and_then(Value::as_array) else {
        return Err(GithubError::new("unexpected pull request data from GitHub", 502));
    };
    nodes.iter().map(parse_pull_request).collect()
}

fn parse_pull_request(node: &Value) -> Result<PullRequest, GithubError> {
    let unexpected = || GithubError::new("unexpected pull request data from GitHub", 502);
    let text = |key: &str| node.get(key).and_then(Value::as_str).map(str::to_owned).ok_or_else(unexpected);
    let state = text("state")?;
    if !matches!(state.as_str(), "OPEN" | "CLOSED" | "MERGED") {
        return Err(unexpected());
    }
    let head_repository = match node.get("headRepository") {
        Some(Value::Null) => None,
        Some(source) => {
            let name = source.get("name").and_then(Value::as_str).ok_or_else(unexpected)?;
            let login = source.pointer("/owner/login").and_then(Value::as_str).ok_or_else(unexpected)?;
            Some(format!("{login}/{name}"))
        }
        None => return Err(unexpected()),
    };
    let url = text("url")?;
    let (_, owner, repo, _) = parse_pr_url(&url)
        .ok_or_else(|| GithubError::new(format!("cannot read the repository from the pull request url: {url}"), 502))?;
    Ok(PullRequest {
        repository: format!("{owner}/{repo}"),
        number: node.get("number").and_then(Value::as_i64).ok_or_else(unexpected)?,
        title: text("title")?,
        state,
        is_draft: node.get("isDraft").and_then(Value::as_bool).ok_or_else(unexpected)?,
        base_ref_oid: text("baseRefOid")?,
        base_ref_name: text("baseRefName")?,
        head_ref_name: text("headRefName")?,
        head_ref_oid: text("headRefOid")?,
        head_repository,
        url,
    })
}
