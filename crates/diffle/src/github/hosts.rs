//! Which GitHub a run talks to, and which remotes point at it.
use std::collections::{BTreeSet, HashMap};
use std::sync::LazyLock;

use regex::Regex;

use super::client::GithubClient;
use crate::git::GitRepo;

/// A run's GitHub: where it is, and a client when there is a token for it.
#[derive(Clone)]
pub struct Github {
    pub instance: GithubInstance,
    pub client: Option<std::sync::Arc<dyn GithubClient>>,
}

impl Github {
    /// github.com without a token: what a run that never configured GitHub sees.
    pub fn tokenless() -> Self {
        Self { instance: GithubInstance::github_com(), client: None }
    }
}

/// The one GitHub a run talks to: github.com, a GitHub Enterprise Server, or a GHE.com tenant.
/// Remotes on other hosts are not GitHub for that run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GithubInstance {
    /// Web host: pull request urls, the UI, the API, `gh auth token --hostname`.
    pub host: String,
    /// Hosts of remote urls that point at it; the web host is always one.
    pub git_hosts: Vec<String>,
}

impl GithubInstance {
    pub fn github_com() -> Self {
        Self { host: "github.com".into(), git_hosts: vec!["github.com".into()] }
    }

    /// REST root; GraphQL sits beside it.
    pub fn api_base_url(&self) -> String {
        if self.host == "github.com" {
            "https://api.github.com".into()
        } else if self.host.ends_with(".ghe.com") {
            format!("https://api.{}", self.host)
        } else {
            format!("https://{}/api/v3", self.host)
        }
    }

    /// The web page of `<owner>/<repo>` on this instance.
    pub fn repository_url(&self, repository: &str) -> String {
        format!("https://{}/{repository}", self.host)
    }

    /// The page showing lines `start..=end` of `path` at commit `sha` in `repository`; each path
    /// segment is escaped.
    pub fn permalink(&self, repository: &str, sha: &str, path: &str, start: i64, end: i64) -> String {
        let mut url = url::Url::parse(&self.repository_url(repository)).expect("a valid host");
        url.path_segments_mut().expect("an http url").extend(["blob", sha]).extend(path.split('/'));
        url.set_fragment(Some(&if start == end { format!("L{start}") } else { format!("L{start}-L{end}") }));
        url.into()
    }

    /// The instance whose web host is `host`: github.com, plus every `githubHosts` entry (git host →
    /// web host, the config file's `githubHosts`) that maps to it.
    fn at(host: &str, github_hosts: &HashMap<String, String>) -> Self {
        let mut git_hosts = vec![host.to_owned()];
        let mut mapped: Vec<&String> =
            github_hosts.iter().filter(|(_, web)| *web == host).map(|(git, _)| git).collect();
        mapped.sort();
        for git in mapped {
            if !git_hosts.contains(git) {
                git_hosts.push(git.clone());
            }
        }
        Self { host: host.to_owned(), git_hosts }
    }
}

static REMOTE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)^(?:(?:https?|ssh|git\+ssh)://(?:[^/@]+@)?([^/:]+)(?::\d+)?/|(?:[^/@]+@)?([^/:]+):)([^/]+)/([^/]+?)/?$",
    )
    .unwrap()
});
static DOT_GIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.git$").unwrap());

/// `<owner>/<repo>` of a configured HTTPS, SSH, or scp-style remote url on `instance`.
pub fn github_repository(url: &str, instance: &GithubInstance) -> Option<String> {
    let (host, repository) = parse_remote(url)?;
    instance.git_hosts.contains(&host).then_some(repository)
}

fn parse_remote(url: &str) -> Option<(String, String)> {
    let m = REMOTE.captures(url)?;
    let host = m.get(1).or_else(|| m.get(2))?.as_str().to_lowercase();
    Some((host, format!("{}/{}", &m[3], DOT_GIT.replace(&m[4], ""))))
}

/// Where a run's GitHub is: a pull request url's host, else origin's, else the one host all GitHub
/// remotes share, else github.com. A remote is GitHub when its host is github.com or a configured
/// git or web host.
pub async fn choose_instance(
    github_hosts: &HashMap<String, String>,
    repo: Option<&GitRepo>,
    pr_selector: Option<&str>,
) -> GithubInstance {
    if let Some(host) = pr_selector.and_then(url_host) {
        let web = github_hosts.get(&host).cloned().unwrap_or(host);
        return GithubInstance::at(&web, github_hosts);
    }
    let known: BTreeSet<&str> = std::iter::once("github.com")
        .chain(github_hosts.keys().map(String::as_str))
        .chain(github_hosts.values().map(String::as_str))
        .collect();
    let remotes = match repo {
        Some(repo) => repo.remotes().await.unwrap_or_default(),
        None => Vec::new(),
    };
    let host_of = |url: &str| {
        let (host, _) = parse_remote(url)?;
        known.contains(host.as_str()).then(|| github_hosts.get(&host).cloned().unwrap_or(host))
    };
    if let Some(host) = remotes.iter().find(|r| r.name == "origin").and_then(|r| host_of(&r.url)) {
        return GithubInstance::at(&host, github_hosts);
    }
    let hosts: BTreeSet<String> = remotes.iter().filter_map(|r| host_of(&r.url)).collect();
    match hosts.into_iter().collect::<Vec<_>>().as_slice() {
        [only] => GithubInstance::at(only, github_hosts),
        _ => GithubInstance::github_com(),
    }
}

/// The lowercased `host[:port]` of an http(s) url.
fn url_host(selector: &str) -> Option<String> {
    let lower = selector.to_lowercase();
    let rest = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://"))?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    (!host.is_empty()).then(|| host.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_owner_and_repo_from_remote_urls_on_the_instance() {
        let com = GithubInstance::github_com();
        for url in [
            "https://github.com/o/r.git",
            "git@github.com:o/r",
            "ssh://git@github.com:22/o/r/",
            "https://user@GitHub.com/o/r",
        ] {
            assert_eq!(github_repository(url, &com).as_deref(), Some("o/r"), "{url}");
        }
        assert_eq!(github_repository("https://gitlab.com/o/r", &com), None);
        assert_eq!(
            GithubInstance { host: "acme.ghe.com".into(), git_hosts: vec![] }.api_base_url(),
            "https://api.acme.ghe.com"
        );
    }
}
