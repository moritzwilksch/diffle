//! Which GitHub a run talks to, and which remotes point at it.
mod common;

use std::collections::HashMap;

use common::TestRepo;
use diffle::github::hosts::{GithubInstance, choose_instance, github_repository};

fn enterprise() -> GithubInstance {
    GithubInstance { host: "github.work.com".into(), git_hosts: vec!["github.work.com".into(), "ssh.work.com".into()] }
}

#[test]
fn reads_owner_and_repo_from_every_remote_url_shape() {
    for url in [
        "https://github.com/o/r",
        "https://github.com/o/r.git",
        "https://user@github.com/o/r/",
        "ssh://git@github.com:22/o/r.git",
        "git@github.com:o/r.git",
        "github.com:o/r",
    ] {
        assert_eq!(github_repository(url, &GithubInstance::github_com()).as_deref(), Some("o/r"), "{url}");
    }
}

#[test]
fn reads_remotes_on_the_instances_hosts_alone_whatever_their_case() {
    let com = GithubInstance::github_com();
    assert_eq!(github_repository("git@SSH.work.com:team/svc.git", &enterprise()).as_deref(), Some("team/svc"));
    assert_eq!(github_repository("https://github.work.com/team/svc", &enterprise()).as_deref(), Some("team/svc"));
    assert_eq!(github_repository("https://github.com/o/r", &enterprise()), None);
    assert_eq!(github_repository("https://github.work.com/team/svc", &com), None);
    assert_eq!(github_repository("https://github.com.evil.example/o/r", &com), None);
    assert_eq!(github_repository("https://github.com/o/r/tree/main", &com), None);
}

#[test]
fn knows_where_github_com_ghe_com_and_an_enterprise_server_keep_their_api() {
    assert_eq!(GithubInstance::github_com().api_base_url(), "https://api.github.com");
    assert_eq!(
        GithubInstance { host: "acme.ghe.com".into(), git_hosts: vec![] }.api_base_url(),
        "https://api.acme.ghe.com"
    );
    assert_eq!(enterprise().api_base_url(), "https://github.work.com/api/v3");
}

/// A repository with these remotes, in order.
fn repo_with(remotes: &[(&str, &str)]) -> TestRepo {
    let t = TestRepo::new();
    for (name, url) in remotes {
        t.git(&["remote", "add", name, url]);
    }
    t
}

fn hosts() -> HashMap<String, String> {
    HashMap::from([("ssh.work.com".to_owned(), "github.work.com".to_owned())])
}

#[tokio::test]
async fn follows_a_configured_origin_through_its_git_host_to_its_web_host() {
    let t = repo_with(&[("origin", "git@ssh.work.com:team/svc.git"), ("gh", "https://github.com/o/r")]);
    let repo = t.open().await;
    assert_eq!(choose_instance(&hosts(), Some(&repo), None).await, enterprise());
    assert_eq!(choose_instance(&HashMap::new(), Some(&repo), None).await, GithubInstance::github_com());
}

#[tokio::test]
async fn takes_the_one_host_every_github_remote_shares_when_origin_is_not_one() {
    let one = repo_with(&[("origin", "https://gitlab.com/o/r"), ("up", "https://github.work.com/team/svc")]);
    assert_eq!(choose_instance(&hosts(), Some(&one.open().await), None).await, enterprise());
    let two = repo_with(&[("up", "https://github.work.com/team/svc"), ("gh", "https://github.com/o/r")]);
    assert_eq!(choose_instance(&hosts(), Some(&two.open().await), None).await, GithubInstance::github_com());
}

#[tokio::test]
async fn follows_a_pull_request_url_anywhere_configured_or_not() {
    let t = repo_with(&[("origin", "https://github.com/o/r")]);
    let repo = t.open().await;
    let pr = Some("https://github.work.com/team/svc/pull/7");
    assert_eq!(choose_instance(&hosts(), Some(&repo), pr).await, enterprise());
    let elsewhere = choose_instance(&HashMap::new(), None, Some("https://ghes.example/team/svc/pull/7")).await;
    assert_eq!(elsewhere, GithubInstance { host: "ghes.example".into(), git_hosts: vec!["ghes.example".into()] });
    assert_eq!(choose_instance(&hosts(), Some(&repo), Some("7")).await, GithubInstance::github_com());
}
