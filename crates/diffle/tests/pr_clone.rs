//! Foreign pull requests in disposable clones. A test binary of its own: the clone reads its git
//! config and temp directory from the process environment, which these tests set.
mod common;

use std::path::Path;
use std::sync::Arc;

use common::git_in;
use common::github::knows;
use common::pr::{Fixture, as_git_url};
use diffle::cli::repository::open_review_repository_with;
use diffle::github::client::GithubClient;
use diffle::github::hosts::{Github, GithubInstance};
use diffle::mode::resolve::resolve_review;
use diffle::protocol::EnterRequest;
use serde_json::json;

fn set(name: &str, value: &Path) {
    // SAFETY: the only test in this binary sets the environment before any thread reads it.
    unsafe { std::env::set_var(name, value) }
}

fn unset(name: &str) {
    // SAFETY: as in `set`.
    unsafe { std::env::remove_var(name) }
}

#[tokio::test]
async fn clones_foreign_prs_into_temp_storage_and_removes_them_including_after_a_failed_clone() {
    let f = Fixture::new();
    let root = f.root();

    // A clone that fails leaves nothing behind in the temp directory.
    let scratch = root.join("failed-clone");
    std::fs::create_dir(&scratch).unwrap();
    let missing = root.join("missing-gitconfig");
    let rewrite =
        format!("[url \"{}/missing\"]\n\tinsteadOf = https://github.com/foreign/missing\n", as_git_url(&root));
    std::fs::write(&missing, rewrite).unwrap();
    set("GIT_CONFIG_GLOBAL", &missing);
    set("TMPDIR", &scratch);
    let foreign = knows(Some(f.node(json!({ "url": "https://github.com/foreign/missing/pull/7" }))));
    let github =
        Github { instance: GithubInstance::github_com(), client: Some(Arc::new(foreign) as Arc<dyn GithubClient>) };
    let mut req = EnterRequest::Pr { pr: Some("7".into()) };
    let gh = github.clone();
    assert!(open_review_repository_with(&mut req, &f.local, async |_| Ok((gh, None))).await.is_err());
    assert_eq!(std::fs::read_dir(&scratch).unwrap().count(), 0);
    unset("TMPDIR");

    // A foreign pull request is cloned, inside a repository or outside any.
    let config = root.join("gitconfig");
    let rewrite = format!("[url \"{}\"]\n\tinsteadOf = https://github.com/foreign/repo\n", as_git_url(&f.origin));
    std::fs::write(&config, rewrite).unwrap();
    set("GIT_CONFIG_GLOBAL", &config);
    let foreign = knows(Some(f.node(json!({ "url": "https://github.com/foreign/repo/pull/7" }))));
    let github =
        Github { instance: GithubInstance::github_com(), client: Some(Arc::new(foreign) as Arc<dyn GithubClient>) };
    let refs = git_in(&f.local, &["show-ref"]);
    let objects = git_in(&f.local, &["count-objects", "-v"]);
    let outside = tempfile::tempdir().unwrap();
    for cwd in [f.local.clone(), outside.path().to_path_buf()] {
        let url = "https://github.com/foreign/repo/pull/7";
        let mut req = EnterRequest::Pr { pr: Some(url.into()) };
        let gh = github.clone();
        let opened = open_review_repository_with(&mut req, &cwd, async |_| Ok((gh, None))).await.unwrap();
        let clone_root = opened.repo.root.clone();
        assert_ne!(clone_root, f.local);
        let temp = dunce::canonicalize(std::env::temp_dir()).unwrap();
        assert!(dunce::canonicalize(&clone_root).unwrap().starts_with(temp.join("")), "{}", clone_root.display());
        assert!(clone_root.file_name().unwrap().to_string_lossy().starts_with("diffle-pr-"));
        let review = resolve_review(&req, &opened.repo, &github).await.unwrap();
        let diffle::protocol::Review::Range { old, new, pr, .. } = &review else { panic!("a range") };
        assert_eq!(opened.repo.resolve(new).await.unwrap(), f.head);
        assert_eq!(opened.repo.resolve(old).await.unwrap(), f.merge_base);
        assert_eq!(pr.as_ref().map(|p| p.url.as_str()), Some(url));
        assert_eq!(git_in(&f.local, &["show-ref"]), refs);
        assert_eq!(git_in(&f.local, &["count-objects", "-v"]), objects);
        drop(review);
        drop(opened);
        assert!(!clone_root.exists(), "{}", clone_root.display());
    }
    unset("GIT_CONFIG_GLOBAL");
}
