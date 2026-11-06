//! Range-diff pairing and patch ids agree with `git range-diff` and `git patch-id --stable`.
mod common;

use std::io::Write;
use std::process::{Command, Stdio};

use common::{TestRepo, git_in};
use diffle::git::GitRepo;
use regex::Regex;

/// `git range-diff -s` rows as (old, marker, new) abbreviations, `-` where a side has none.
fn git_rows(dir: &std::path::Path, a: &str, b: &str) -> Vec<(String, char, String)> {
    let out = git_in(dir, &["range-diff", "-s", "--no-color", "--creation-factor=100", a, b]);
    let row = Regex::new(r"^\s*(?:\d+:\s+([0-9a-f]+)|-:\s+-+)\s+([=!<>])\s+(?:\d+:\s+([0-9a-f]+)|-:\s+-+)\s").unwrap();
    out.lines()
        .filter_map(|l| row.captures(l))
        .map(|m| {
            let side = |i| m.get(i).map_or_else(|| "-".to_owned(), |s| s.as_str().to_owned());
            (side(1), m[2].chars().next().unwrap(), side(3))
        })
        .collect()
}

async fn assert_rows(dir: &std::path::Path, repo: &GitRepo, a: &str, b: &str) {
    let ours = repo.range_diff(a, b).await.unwrap();
    let theirs = git_rows(dir, a, b);
    let short = |sha: &Option<String>, abbrev: &str| match sha {
        Some(sha) if sha.starts_with(abbrev) => abbrev.to_owned(),
        Some(sha) => sha.clone(),
        None => "-".to_owned(),
    };
    let mine: Vec<_> =
        ours.iter().zip(&theirs).map(|(r, t)| (short(&r.old, &t.0), r.marker, short(&r.new, &t.2))).collect();
    assert_eq!(mine, theirs[..mine.len()], "range-diff {a} {b}");
    assert_eq!(ours.len(), theirs.len(), "range-diff rows {a} {b}");
}

async fn assert_patch_ids(dir: &std::path::Path, repo: &GitRepo, shas: &[String]) {
    let mut log = Command::new("git")
        .args(["-c", "core.quotePath=false", "-c", "diff.noprefix=false", "log", "-p", "--no-color", "--no-walk"])
        .args(["--no-show-signature", "--format=%H", "--end-of-options"])
        .args(shas)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(log.status.success());
    let mut patch_id = Command::new("git")
        .args(["patch-id", "--stable"])
        .current_dir(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    patch_id.stdin.take().unwrap().write_all(&std::mem::take(&mut log.stdout)).unwrap();
    let out = String::from_utf8(patch_id.wait_with_output().unwrap().stdout).unwrap();
    let theirs: std::collections::BTreeMap<String, String> =
        out.lines().filter_map(|l| l.split_once(' ')).map(|(id, sha)| (sha.to_owned(), id.to_owned())).collect();
    let ours: std::collections::BTreeMap<String, String> = repo.patch_ids(shas).await.unwrap().into_iter().collect();
    assert_eq!(ours, theirs);
}

/// A base, a series of eight commits on it, and that series rebased onto a moved base with
/// commits reworded, amended, dropped, inserted and swapped.
fn series_repo() -> TestRepo {
    let t = TestRepo::new();
    for f in 0..6 {
        t.write(&format!("f{f}.txt"), (0..30).map(|i| format!("file {f} line {i}\n")).collect::<String>());
    }
    t.commit("base");
    t.git(&["checkout", "-q", "-b", "a"]);
    let edit = |t: &TestRepo, f: usize, line: usize, text: &str| {
        let path = t.path.join(format!("f{f}.txt"));
        let body =
            std::fs::read_to_string(&path).unwrap().replace(&format!("file {f} line {line}\n"), &format!("{text}\n"));
        std::fs::write(path, body).unwrap();
    };
    for c in 0..8 {
        edit(&t, c % 6, 3 + c, &format!("series change {c}"));
        t.commit(&format!("change {c}\n\nwhy {c}"));
    }
    t.git(&["checkout", "-q", "main"]);
    edit(&t, 5, 29, "upstream moved");
    t.commit("upstream");
    t.git(&["checkout", "-q", "-b", "b"]);
    for c in [0, 1, 2, 3, 4, 7, 6] {
        edit(&t, c % 6, 3 + c, &format!("series change {c}"));
        if c == 3 {
            edit(&t, 3, 20, "amended too");
        }
        let message = match c {
            1 => "change 1, reworded\n\nwhy 1".to_owned(),
            _ => format!("change {c}\n\nwhy {c}"),
        };
        t.commit(&message);
        if c == 2 {
            t.write("new.txt", "inserted\n");
            t.commit("inserted");
        }
    }
    t
}

#[tokio::test]
async fn pairs_a_rebased_series_and_ids_its_patches_as_git_does() {
    let t = series_repo();
    let repo = t.open().await;
    assert_rows(&t.path, &repo, "main~1..a", "main..b").await;
    assert_rows(&t.path, &repo, "main..b", "main~1..a").await;
    assert_rows(&t.path, &repo, "main~1..a~3", "main..b").await;
    let shas: Vec<String> = t.git(&["rev-list", "--all"]).lines().map(str::to_owned).collect();
    assert_patch_ids(&t.path, &repo, &shas).await;
}

/// Windows of a real history against shifted ones, and every commit's patch id:
/// `DIFFLE_PARITY_REPO=<dir> cargo test --test series_parity -- --ignored`.
#[tokio::test]
#[ignore]
async fn matches_git_over_a_real_history() {
    let dir = std::path::PathBuf::from(std::env::var("DIFFLE_PARITY_REPO").expect("DIFFLE_PARITY_REPO"));
    let repo = GitRepo::open(&dir).await.unwrap();
    for k in [0, 7, 20, 41] {
        let (a, b) = (format!("HEAD~{}..HEAD~{}", k + 20, k), format!("HEAD~{}..HEAD~{}", k + 26, k + 4));
        assert_rows(&dir, &repo, &a, &b).await;
    }
    let shas: Vec<String> = git_in(&dir, &["rev-list", "-n", "300", "HEAD"]).lines().map(str::to_owned).collect();
    assert_patch_ids(&dir, &repo, &shas).await;
}

#[tokio::test]
async fn the_rebased_series_shows_every_kind_of_row() {
    let t = series_repo();
    let markers: String = git_rows(&t.path, "main~1..a", "main..b").iter().map(|r| r.1).collect();
    for marker in ['=', '!', '<', '>'] {
        assert!(markers.contains(marker), "{markers}");
    }
}

#[tokio::test]
async fn ids_patches_whose_files_end_without_a_newline() {
    let t = TestRepo::new();
    t.write("a.txt", "one");
    t.commit("unterminated");
    t.write("a.txt", "one\ntwo");
    t.commit("still unterminated");
    let shas: Vec<String> = t.git(&["rev-list", "--all"]).lines().map(str::to_owned).collect();
    assert_patch_ids(&t.path, &t.open().await, &shas).await;
}
