//! Diffle's in-process diff prints what `git diff -M` prints: the same files, line counts and patch text.
mod common;

use std::process::Command;

use common::TestRepo;
use diffle::git::GitRepo;
use diffle::protocol::ChangedFile;

/// `git diff` with the config diffle's reader assumes, and `-z --numstat` or a patch.
fn git_diff(dir: &std::path::Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(["-c", "core.quotePath=false", "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false"])
        .args(["-c", "diff.renames=true", "diff", "--no-color", "--no-ext-diff", "-M"])
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", std::env::temp_dir().join("diffle-tests-no-global-gitconfig"))
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// Each file's patch, keyed by its `diff --git` line, sorted: git and diffle may order renames differently.
fn blocks(patch: &str) -> Vec<String> {
    let mut out: Vec<String> =
        patch.split("\ndiff --git ").map(|b| b.trim_start_matches("diff --git ").to_owned()).collect();
    out.retain(|b| !b.is_empty());
    out.iter_mut().for_each(|b| {
        if !b.ends_with('\n') {
            b.push('\n');
        }
    });
    out.sort();
    out
}

/// `--numstat -z` as `(path, old path, additions, deletions)`, binaries as `-1`.
fn numstat(raw: &str) -> Vec<(String, Option<String>, i64, i64)> {
    let mut parts = raw.split('\0');
    let mut out = Vec::new();
    while let Some(record) = parts.next() {
        let mut fields = record.splitn(3, '\t');
        let (Some(add), Some(del), Some(path)) = (fields.next(), fields.next(), fields.next()) else { continue };
        let count = |n: &str| n.parse().unwrap_or(-1);
        let (path, old) = if path.is_empty() {
            let old = parts.next().unwrap().to_owned();
            (parts.next().unwrap().to_owned(), Some(old))
        } else {
            (path.to_owned(), None)
        };
        out.push((path, old, count(add), count(del)));
    }
    out.sort();
    out
}

fn ours(files: &[ChangedFile]) -> Vec<(String, Option<String>, i64, i64)> {
    let mut out: Vec<_> = files
        .iter()
        .map(|f| {
            let (a, d) = if f.binary { (-1, -1) } else { (f.additions, f.deletions) };
            (f.path.clone(), f.old_path.clone(), a, d)
        })
        .collect();
    out.sort();
    out
}

async fn assert_same(dir: &std::path::Path, repo: &GitRepo, old: &str, new: &str, git_args: &[&str], context: u32) {
    let files = repo.numstat(old, new).await.unwrap();
    let mut args = vec!["--numstat", "-z"];
    args.extend(git_args);
    let (mine, theirs) = (ours(&files), numstat(&git_diff(dir, &args)));
    if mine != theirs {
        type Stat = (String, Option<String>, i64, i64);
        let only = |a: &[Stat], b: &[Stat]| a.iter().filter(|x| !b.contains(x)).cloned().collect::<Vec<_>>();
        panic!("numstat {old}..{new}\nours only: {:#?}\ngit only: {:#?}", only(&mine, &theirs), only(&theirs, &mine));
    }
    let unified = format!("-U{context}");
    let mut args = vec![unified.as_str()];
    args.extend(git_args);
    let theirs = blocks(&git_diff(dir, &args));
    let mine = blocks(&repo.patch_all(old, new, &files, context).await.unwrap());
    for (a, b) in mine.iter().zip(&theirs) {
        if a != b {
            let at =
                a.lines().zip(b.lines()).position(|(x, y)| x != y).unwrap_or(a.lines().count().min(b.lines().count()));
            let around = |s: &str| s.lines().skip(at.saturating_sub(3)).take(6).collect::<Vec<_>>().join("\n");
            panic!(
                "patch {old}..{new} differs at line {at} of\n{}\n--- ours\n{}\n--- git\n{}",
                b.lines().next().unwrap_or_default(),
                around(a),
                around(b)
            );
        }
    }
    assert_eq!(mine.len(), theirs.len(), "patch count {old}..{new}");
}

fn varied(t: &TestRepo) {
    let body = |n: usize| (1..=n).map(|i| format!("line {i}\n")).collect::<String>();
    let code = "fn alpha() {\n    let a = 1;\n    let b = 2;\n    let c = 3;\n}\n\n_private() {\n    x\n    y\n    z\n}\n\nfn gamma() {\n    1\n    2\n    3\n    4\n    5\n    6\n    7\n    8\n}\n";
    t.write("code.rs", code);
    t.write("long.txt", body(60));
    t.write("noeol.txt", "a\nb\nc");
    t.write("gone.txt", "bye\n");
    t.write("moved/exact.txt", body(20));
    t.write("moved/edited.txt", body(40));
    t.write("unlike.txt", body(10));
    t.write("mode.sh", "echo hi\n");
    t.write("bin.dat", b"\x00\x01\x02binary\n");
    t.write("empty-gone", "");
    t.write("with space.txt", "s\n");
    t.write("quote\"d.txt", "q\n");
    t.write("ünï.txt", "u\n");
    t.write("crlf.txt", "a\r\nb\r\n");
    t.write("typed", "a file\n");
    t.write(".gitattributes", "*.lock -diff\n");
    t.write("deps.lock", "v1\n");
    t.commit("base");
    t.write("code.rs", code.replace("let b = 2;", "let b = 20;").replace("    7\n", "    seven\n"));
    let mut long = body(60);
    long = long.replace("line 5\n", "line five\n").replace("line 12\n", "").replace("line 50\n", "line 50\nextra\n");
    t.write("long.txt", long);
    t.write("noeol.txt", "a\nb\nC");
    t.rm("gone.txt");
    t.rm("moved/exact.txt");
    t.write("elsewhere/exact.txt", body(20));
    t.rm("moved/edited.txt");
    t.write("elsewhere/edited.md", body(40).replace("line 7\n", "line seven\n"));
    t.rm("unlike.txt");
    t.write("unlike2.txt", "nothing alike\n");
    t.write("bin.dat", b"\x00\x01\x03binary!\n");
    t.rm("empty-gone");
    t.write("empty-new", "");
    t.write("with space.txt", "s2\n");
    t.write("quote\"d.txt", "q2\n");
    t.write("ünï.txt", "u2\n");
    t.write("crlf.txt", "a\r\nB\r\n");
    t.write("deps.lock", "v2\n");
    t.write("added.txt", "new\nlines\n");
    t.write("new space.txt", "spaced\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(t.path.join("mode.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
        t.rm("typed");
        std::os::unix::fs::symlink("code.rs", t.path.join("typed")).unwrap();
        t.write("odd\nname.txt", "n\n");
    }
}

#[tokio::test]
async fn matches_git_between_commits_and_against_the_worktree_both_ways() {
    let t = TestRepo::new();
    varied(&t);
    let repo = t.open().await;
    // Against the worktree, git sees only what the index tracks; stage the new paths (not their content).
    t.git(&["add", "-A", "--intent-to-add"]);
    assert_same(&t.path, &repo, "HEAD", "worktree", &["HEAD"], 3).await;
    // Diffle keeps the old side `a/` when the worktree is it, as it passed git these prefixes.
    assert_same(&t.path, &repo, "worktree", "HEAD", &["-R", "--src-prefix=b/", "--dst-prefix=a/", "HEAD"], 3).await;
    t.git(&["add", "-A"]);
    t.git(&["commit", "-q", "-m", "changes"]);
    for context in [0, 1, 3, 10] {
        assert_same(&t.path, &repo, "HEAD~1", "HEAD", &["HEAD~1", "HEAD"], context).await;
    }
    assert_same(&t.path, &repo, "HEAD", "HEAD~1", &["HEAD", "HEAD~1"], 3).await;
}

/// Every commit of a real history against its parent: `DIFFLE_PARITY_REPO=<dir> cargo test -- --ignored`.
#[tokio::test]
#[ignore]
async fn matches_git_over_a_real_history() {
    let dir = std::path::PathBuf::from(std::env::var("DIFFLE_PARITY_REPO").expect("DIFFLE_PARITY_REPO"));
    let repo = GitRepo::open(&dir).await.unwrap();
    let limit = std::env::var("DIFFLE_PARITY_COMMITS").unwrap_or_else(|_| "200".into());
    let commits =
        common::git_in(&dir, &["rev-list", "--no-merges", "--max-parents=1", "--min-parents=1", "-n", &limit, "HEAD"]);
    for sha in commits.lines() {
        let parent = format!("{sha}^");
        assert_same(&dir, &repo, &parent, sha, &[&parent, sha], 3).await;
    }
}

/// The worktree against HEAD both ways, in a repository whose worktree the caller dirtied:
/// `DIFFLE_PARITY_REPO=<dir> cargo test -- --ignored worktree`. New files must be `git add -N`ed.
#[tokio::test]
#[ignore]
async fn matches_git_against_a_dirty_worktree() {
    let dir = std::path::PathBuf::from(std::env::var("DIFFLE_PARITY_REPO").expect("DIFFLE_PARITY_REPO"));
    let repo = GitRepo::open(&dir).await.unwrap();
    assert_same(&dir, &repo, "HEAD", "worktree", &["HEAD"], 3).await;
    let reverse = ["-R", "--src-prefix=b/", "--dst-prefix=a/", "HEAD"];
    assert_same(&dir, &repo, "worktree", "HEAD", &reverse, 3).await;
}
