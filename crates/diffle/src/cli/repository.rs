//! The repository a run reviews, and the GitHub it talks to: local, or a clone for a foreign pull request.
use std::path::Path;
use std::sync::Arc;

use crate::error::{Error, GithubError, Result};
use crate::git::GitRepo;
use crate::github::client::{HttpClient, no_token, resolve_token};
use crate::github::hosts::{Github, choose_instance};
use crate::github::pulls::view_pr;
use crate::mode::resolve::remote_slug;
use crate::protocol::EnterRequest;

pub struct Opened {
    pub repo: Arc<GitRepo>,
    pub github: Github,
    /// Where the token came from, for the startup line.
    pub token_source: Option<String>,
    /// A foreign pull request's disposable clone, removed when the run drops it.
    pub clone: Option<tempfile::TempDir>,
}

fn is_url(selector: &str) -> bool {
    let lower = selector.to_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// Opens what `req` reviews from `cwd`. Foreign pull requests live in a disposable clone, never in
/// the caller's object database; `req` then names the pull request by url, so a numberless or
/// branch selector stays tied to it.
pub async fn open_review_repository(
    req: &mut EnterRequest,
    cwd: &Path,
    github_hosts: &std::collections::HashMap<String, String>,
) -> Result<Opened> {
    let selector = match &*req {
        EnterRequest::Pr { pr } => pr.clone(),
        _ => None,
    };
    open_review_repository_with(req, cwd, async |local| connect_github(github_hosts, local, selector.as_deref()).await)
        .await
}

/// `open_review_repository`, finding the run's GitHub through `connect` from the local repository,
/// when there is one. Test seam.
pub async fn open_review_repository_with(
    req: &mut EnterRequest,
    cwd: &Path,
    connect: impl AsyncFnOnce(Option<&GitRepo>) -> Result<(Github, Option<String>)>,
) -> Result<Opened> {
    let selector = match &*req {
        EnterRequest::Pr { pr } => pr.clone(),
        _ => None,
    };
    let local = match GitRepo::open(cwd).await {
        Ok(repo) => Some(repo),
        // Outside a repository only a pull request url can say what to review.
        Err(Error::Git(e)) if e.code == Some(128) && selector.as_deref().is_some_and(is_url) => None,
        Err(e) => return Err(e),
    };
    let (github, token_source) = connect(local.as_ref()).await?;
    let opened = |repo: GitRepo, github: Github, clone| Opened {
        repo: Arc::new(repo),
        github,
        token_source: token_source.clone(),
        clone,
    };
    let EnterRequest::Pr { pr } = req else {
        return Ok(opened(local.expect("a repository outside pr mode"), github, None));
    };
    let Some(client) = github.client.clone() else {
        return Err(GithubError::conflict(no_token(&github.instance.host)).into());
    };
    let found = view_pr(pr.as_deref(), local.as_ref(), client.as_ref(), &github.instance, None).await?;
    if let Some(local) = local {
        let remotes = local.remotes().await?;
        if remotes.iter().any(|r| remote_slug(&r.url) == found.repository.to_lowercase()) {
            return Ok(opened(local, github, None));
        }
    }
    let dir = tempfile::Builder::new().prefix("diffle-pr-").tempdir()?;
    let url = &found.url[..found.url.find("/pull/").unwrap_or(found.url.len())];
    let repo = GitRepo::clone_into(url, dir.path()).await?;
    *pr = Some(found.url.clone());
    Ok(opened(repo, github, Some(dir)))
}

/// One GitHub and one token lookup per run; without a token, GitHub features are off rather than
/// failing later. `GITHUB_API_URL`, as Actions sets it, names the run's API outright.
async fn connect_github(
    github_hosts: &std::collections::HashMap<String, String>,
    local: Option<&GitRepo>,
    selector: Option<&str>,
) -> Result<(Github, Option<String>)> {
    let instance = choose_instance(github_hosts, local, selector).await;
    let env = |name: &str| std::env::var(name).ok();
    let Some((token, source)) = resolve_token(&instance.host, env).await else {
        return Ok((Github { instance, client: None }, None));
    };
    let base = env("GITHUB_API_URL").filter(|u| !u.is_empty()).unwrap_or_else(|| instance.api_base_url());
    let client = HttpClient::new(token, &base)?;
    Ok((Github { instance, client: Some(Arc::new(client)) }, Some(source)))
}
