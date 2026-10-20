mod common;

use std::collections::HashMap;

use common::TestRepo;
use diffle::git::{BIG_FILE_THRESHOLD, GitRepo, GrepOptions};
use diffle::protocol::{ChangeStatus, ChangedFile};

/// main and feat diverge from `base`; feat has uncommitted edits, an untracked and an ignored file.
fn feature_repo() -> TestRepo {
    let t = TestRepo::new();
    t.write("a.txt", "one\ntwo\n");
    t.write("keep.txt", "k\n");
    t.commit("base");
    t.git(&["checkout", "-q", "-b", "feat"]);
    t.write("a.txt", "one\ntwo\nthree\n");
    t.write("new.txt", "n\n");
    t.commit("feat 1");
    t.git(&["checkout", "-q", "main"]);
    t.write("keep.txt", "k2\n");
    t.commit("main moves on");
    t.git(&["checkout", "-q", "feat"]);
    t.write("a.txt", "one\ntwo\nthree\nfour\n");
    t.write("untracked.txt", "u\n");
    t.write(".gitignore", "ignored.txt\n");
    t.write("ignored.txt", "i\n");
    t
}

fn summary(files: &[ChangedFile]) -> Vec<(&str, ChangeStatus, i64, i64)> {
    files.iter().map(|f| (f.path.as_str(), f.status, f.additions, f.deletions)).collect()
}

fn find<'a>(files: &'a [ChangedFile], path: &str) -> &'a ChangedFile {
    files.iter().find(|f| f.path == path).unwrap_or_else(|| panic!("{path} not changed"))
}

#[tokio::test]
async fn previews_both_last_commit_endpoints_and_reports_missing_ancestors() {
    let t = feature_repo();
    let repo = t.open().await;
    let preview = repo.last_commits_preview(1, 0).await.unwrap();
    let (old, new) = (preview.old.clone().unwrap(), preview.new.clone().unwrap());
    assert_eq!((old.message.as_str(), new.message.as_str()), ("base", "feat 1"));
    assert_eq!(old.sha, t.git(&["rev-parse", "HEAD~1"]));
    let missing = repo.last_commits_preview(999, 0).await.unwrap();
    assert!(missing.old.is_none());
    assert_eq!(missing.new.unwrap().sha, new.sha);
    let reversed = repo.last_commits_preview(0, 1).await.unwrap();
    assert_eq!((reversed.old.unwrap().sha, reversed.new.unwrap().sha), (new.sha, old.sha));
}

#[tokio::test]
async fn opens_from_a_subdirectory_and_resolves_root_and_git_dir() {
    let t = feature_repo();
    std::fs::create_dir(t.path.join("sub")).unwrap();
    let sub = GitRepo::open(&t.path.join("sub")).await.unwrap();
    assert_eq!(sub.root, t.path);
    assert_eq!(sub.git_dir, t.path.join(".git"));
    assert_eq!(sub.common_dir, t.path.join(".git"));
}

#[tokio::test]
async fn lists_tracked_and_untracked_files_honouring_gitignore() {
    let t = feature_repo();
    let repo = t.open().await;
    assert_eq!(repo.ls_files().await.unwrap(), ["a.txt", "keep.txt", "new.txt"]);
    assert_eq!(repo.untracked().await.unwrap(), [".gitignore", "untracked.txt"]);
    assert_eq!(repo.ignored_paths().await.unwrap(), ["ignored.txt"]);
}

#[tokio::test]
async fn numstat_against_the_worktree_includes_untracked_files_as_added() {
    let t = feature_repo();
    let repo = t.open().await;
    let files = repo.numstat("HEAD", "worktree").await.unwrap();
    assert_eq!(
        summary(&files),
        [
            (".gitignore", ChangeStatus::A, 1, 0),
            ("a.txt", ChangeStatus::M, 1, 0),
            ("untracked.txt", ChangeStatus::A, 1, 0)
        ]
    );
    assert!(files.iter().all(|f| f.blob.len() == 40));
}

#[tokio::test]
async fn numstat_between_revs_carries_each_sides_blob() {
    let t = feature_repo();
    let repo = t.open().await;
    let mb = repo.merge_base("main", "feat").await.unwrap();
    let files = repo.numstat(&mb, "feat").await.unwrap();
    assert_eq!(summary(&files), [("a.txt", ChangeStatus::M, 1, 0), ("new.txt", ChangeStatus::A, 1, 0)]);
    let blobs: Vec<&str> = files.iter().map(|f| f.blob.as_str()).collect();
    assert_eq!(blobs, [t.git(&["rev-parse", "feat:a.txt"]), t.git(&["rev-parse", "feat:new.txt"])]);
    let old: Vec<&str> = files.iter().map(|f| f.old_blob.as_str()).collect();
    assert_eq!(old, [t.git(&["rev-parse", &format!("{mb}:a.txt")]).as_str(), ""]);
}

#[tokio::test]
async fn numstat_reports_renames_and_binaries() {
    let t = feature_repo();
    t.write("bin.dat", [0u8, 1, 2]);
    t.git(&["mv", "keep.txt", "moved.txt"]);
    let files = t.open().await.numstat("HEAD", "worktree").await.unwrap();
    let moved = find(&files, "moved.txt");
    assert_eq!((moved.status, moved.old_path.as_deref(), moved.additions), (ChangeStatus::R, Some("keep.txt"), 0));
    let bin = find(&files, "bin.dat");
    assert_eq!((bin.status, bin.binary, bin.additions), (ChangeStatus::A, true, 0));
    assert_eq!(find(&files, "a.txt").blob, t.git(&["hash-object", "--", "a.txt"]));
    assert_eq!(find(&files, "a.txt").old_blob, t.git(&["rev-parse", "HEAD:a.txt"]));
}

// Windows rejects `\n` in a filename.
#[cfg(unix)]
#[tokio::test]
async fn numstat_reports_a_path_containing_a_newline() {
    let t = feature_repo();
    t.write("odd\nname.txt", "odd\n");
    let files = t.open().await.numstat("HEAD", "worktree").await.unwrap();
    let odd = find(&files, "odd\nname.txt");
    assert_eq!((odd.status, odd.additions), (ChangeStatus::A, 1));
    assert_eq!(odd.blob, t.git(&["hash-object", "--", "odd\nname.txt"]));
}

#[tokio::test]
async fn treats_option_shaped_revisions_as_names() {
    let t = feature_repo();
    let repo = t.open().await;
    assert!(repo.resolve("--all").await.is_err());
    assert!(repo.resolve("--output=/tmp/x").await.is_err());
    assert!(repo.merge_base("--all", "HEAD").await.is_err());
}

#[tokio::test]
async fn patch_many_covers_tracked_and_untracked_files_and_nothing_else() {
    let t = feature_repo();
    let repo = t.open().await;
    let files = repo.numstat("HEAD", "worktree").await.unwrap();
    let pick = |paths: &[&str]| files.iter().filter(|f| paths.contains(&f.path.as_str())).cloned().collect::<Vec<_>>();
    let both = repo.patch_many("HEAD", "worktree", &pick(&["a.txt", "untracked.txt"]), 3).await.unwrap();
    assert!(both.contains("+++ b/a.txt") && both.contains("+++ b/untracked.txt"), "{both}");
    assert!(!repo.patch_many("HEAD", "worktree", &pick(&["untracked.txt"]), 3).await.unwrap().contains("a.txt"));
    assert_eq!(repo.patch_many("HEAD", "worktree", &[], 3).await.unwrap(), "");
}

#[tokio::test]
async fn marks_an_untracked_file_at_the_big_file_threshold_binary_without_reading_it() {
    let t = feature_repo();
    // Sparse where the filesystem allows it: the size is what matters, not the bytes.
    std::fs::File::create(t.path.join("huge.bin")).unwrap().set_len(BIG_FILE_THRESHOLD).unwrap();
    let repo = t.open().await;
    let files = repo.numstat("HEAD", "worktree").await.unwrap();
    let huge = find(&files, "huge.bin");
    assert_eq!((huge.status, huge.binary, huge.additions), (ChangeStatus::A, true, 0));
    assert!(!repo.patch_all("HEAD", "worktree", &files, 3).await.unwrap().contains("huge.bin"));
}

#[tokio::test]
async fn reads_either_side_and_refuses_path_traversal() {
    let t = feature_repo();
    let repo = t.open().await;
    assert_eq!(repo.show("HEAD", "a.txt").await.unwrap().unwrap(), b"one\ntwo\nthree\n");
    assert!(repo.show("HEAD", "missing.txt").await.unwrap().is_none());
    assert_eq!(repo.read_worktree("a.txt").await.unwrap().unwrap(), b"one\ntwo\nthree\nfour\n");
    assert!(repo.read_worktree("../etc/passwd").await.unwrap().is_none());
}

#[tokio::test]
async fn bounds_search_results_globally_and_flags_truncation_only_when_more_exist() {
    let t = feature_repo();
    let repo = t.open().await;
    let grep = |limit| repo.grep("o", "worktree", limit, GrepOptions::default());
    let all = grep(50).await.unwrap();
    assert!(all.matches.len() >= 3 && !all.truncated);
    let exact = grep(all.matches.len()).await.unwrap();
    assert_eq!((exact.matches.clone(), exact.truncated), (all.matches.clone(), false));
    let cut = grep(2).await.unwrap();
    assert_eq!((cut.matches, cut.truncated), (all.matches[..2].to_vec(), true));
}

async fn visible_lines(repo: &GitRepo, rev: &str, ranges: &[(i64, i64)]) -> (Vec<i64>, bool) {
    let paths = ["a.txt".to_owned()];
    let ranges = HashMap::from([("a.txt".to_owned(), ranges.to_vec())]);
    let opts = GrepOptions { paths: Some(&paths), ranges: Some(&ranges), ..Default::default() };
    let r = repo.grep("o", rev, 1, opts).await.unwrap();
    (r.matches.iter().map(|m| m.line).collect(), r.truncated)
}

#[tokio::test]
async fn applies_visible_line_ranges_before_counting_and_truncating_matches() {
    let t = feature_repo();
    let repo = t.open().await;
    assert_eq!(visible_lines(&repo, "worktree", &[(3, 4)]).await, (vec![4], false));
    assert_eq!(visible_lines(&repo, "worktree", &[(2, 4)]).await, (vec![2], true));
    assert_eq!(visible_lines(&repo, "feat", &[(2, 4)]).await, (vec![2], false));
}

#[tokio::test]
async fn searches_by_word_case_regex_and_literal_paths() {
    let t = feature_repo();
    let repo = t.open().await;
    let hits = |query: &'static str, opts: GrepOptions<'static>| {
        let repo = &repo;
        async move {
            repo.grep(query, "worktree", 50, opts)
                .await
                .unwrap()
                .matches
                .into_iter()
                .map(|m| (m.path, m.line))
                .collect::<Vec<_>>()
        }
    };
    let word = || GrepOptions { word: true, ..Default::default() };
    assert_eq!(hits("one", word()).await, [("a.txt".to_owned(), 1)]);
    assert!(hits("on", word()).await.is_empty());
    assert!(!hits("on", GrepOptions::default()).await.is_empty());
    assert!(hits("ONE", GrepOptions::default()).await.is_empty());
    assert_eq!(hits("ONE", GrepOptions { ignore_case: true, ..Default::default() }).await.len(), 1);
    assert!(hits("t(wo|hree)", GrepOptions::default()).await.is_empty());
    let lines: Vec<i64> =
        hits("t(wo|hree)", GrepOptions { regex: true, ..Default::default() }).await.into_iter().map(|h| h.1).collect();
    assert_eq!(lines, [2, 3]);
    static A: [String; 0] = [];
    assert!(hits("o", GrepOptions { paths: Some(&A), ..Default::default() }).await.is_empty());
    let star = vec!["*.txt".to_owned()].leak();
    // `*` is a literal character, not a glob, so it selects no file.
    assert!(hits("o", GrepOptions { paths: Some(star), ..Default::default() }).await.is_empty());
}

#[tokio::test]
async fn lists_refs_and_survives_an_unborn_branch() {
    let t = feature_repo();
    let repo = t.open().await;
    let refs = repo.refs().await.unwrap();
    assert_eq!(refs.current.as_deref(), Some("feat"));
    let mut branches = refs.branches.clone();
    branches.sort();
    assert_eq!(branches, ["feat", "main"]);
    assert_eq!(refs.recent[0].subject, "feat 1");
    let unborn = TestRepo::new();
    let empty = unborn.open().await.refs().await.unwrap();
    assert!(empty.branches.is_empty() && empty.recent.is_empty() && empty.current.is_none());
}
