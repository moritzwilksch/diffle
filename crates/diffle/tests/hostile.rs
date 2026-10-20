//! Repository config that would break the parsers if the overrides did not pin it.
mod common;

use common::TestRepo;
use diffle::git::GrepOptions;

fn hostile_repo() -> TestRepo {
    let t = TestRepo::new();
    for (key, value) in [
        ("diff.noprefix", "true"),
        ("diff.mnemonicPrefix", "true"),
        ("diff.external", "/bin/false"),
        ("color.ui", "always"),
        // Per-command colour settings win over color.ui, so pin them separately.
        ("color.diff", "always"),
        ("color.grep", "always"),
        ("grep.column", "true"),
        ("core.quotePath", "true"),
    ] {
        t.git(&["config", key, value]);
    }
    t.write("ä.txt", "eins\n");
    t.write("plain.txt", "p\n");
    t.commit("base");
    t.write("ä.txt", "eins\nzwei\n");
    t.git(&["commit", "-q", "-am", "edit"]);
    t.write("ä.txt", "eins\nzwei\ndrei\n");
    t.write("ü.txt", "neu\n");
    t
}

#[tokio::test]
async fn ignores_diff_prefix_external_diff_and_colour_settings_in_patches() {
    let t = hostile_repo();
    let repo = t.open().await;
    let files = repo.numstat("HEAD~1", "HEAD").await.unwrap();
    assert_eq!(files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["ä.txt"]);
    let p = repo.patch("HEAD~1", "HEAD", &files[0], 3, None).await.unwrap();
    for part in ["diff --git a/ä.txt b/ä.txt\n", "+++ b/ä.txt\n", "+zwei"] {
        assert!(p.contains(part), "{part} missing from {p}");
    }
    assert!(!p.contains("\u{1b}["));
    assert_eq!(repo.patch_all("HEAD~1", "HEAD", &files, 3).await.unwrap(), p);
}

#[tokio::test]
async fn names_non_ascii_paths_verbatim_in_worktree_patches_including_untracked_files() {
    let t = hostile_repo();
    let repo = t.open().await;
    let files = repo.numstat("HEAD", "worktree").await.unwrap();
    assert_eq!(files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["ä.txt", "ü.txt"]);
    let u = repo.patch("HEAD", "worktree", &files[1], 3, None).await.unwrap();
    assert!(u.contains("diff --git a/ü.txt b/ü.txt\n") && u.contains("+++ b/ü.txt\n"), "{u}");
    let all = repo.patch_all("HEAD", "worktree", &files, 3).await.unwrap();
    assert!(all.contains("diff --git a/ä.txt b/ä.txt\n") && all.contains("diff --git a/ü.txt b/ü.txt\n"));
    assert!(!all.contains("\\303") && !all.contains("\u{1b}["));
}

// Windows forbids `"` in a filename.
#[cfg(unix)]
#[tokio::test]
async fn mirrors_the_quoting_of_the_new_side_when_rewriting_the_dev_null_header() {
    let t = hostile_repo();
    t.write("qu\"ote.txt", "q\n");
    let repo = t.open().await;
    let files = repo.numstat("HEAD", "worktree").await.unwrap();
    let file = files.iter().find(|f| f.path == "qu\"ote.txt").unwrap();
    let p = repo.patch("HEAD", "worktree", file, 3, None).await.unwrap();
    assert!(p.contains("diff --git \"a/qu\\\"ote.txt\" \"b/qu\\\"ote.txt\"\n"), "{p}");
    assert!(!p.contains("dev/null b/"));
}

#[tokio::test]
async fn searches_without_colour_escapes_or_a_column_field() {
    let t = hostile_repo();
    let repo = t.open().await;
    for rev in ["worktree", "HEAD"] {
        let hits = repo.grep("zwei", rev, 10, GrepOptions::default()).await.unwrap().matches;
        assert_eq!(hits.len(), 1);
        assert_eq!((hits[0].path.as_str(), hits[0].line, hits[0].text.as_str()), ("ä.txt", 2, "zwei"));
    }
}
