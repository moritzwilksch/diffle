//! What diffle reads in-process through gix agrees with what the git CLI answers for the same repository.
mod common;

use std::collections::HashMap;
use std::process::Command;

use common::TestRepo;

/// Commits at a fixed committer date, so ties between branches are certain rather than likely.
fn commit_at(t: &TestRepo, message: &str, date: &str) {
    t.git(&["add", "-A"]);
    let out = Command::new("git")
        .args(["commit", "-q", "--allow-empty", "-m", message])
        .current_dir(&t.path)
        .env("GIT_AUTHOR_NAME", "Ann Author")
        .env("GIT_AUTHOR_EMAIL", "ann@example.com")
        .env("GIT_AUTHOR_DATE", date)
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .env("GIT_COMMITTER_DATE", date)
        .env("GIT_CONFIG_GLOBAL", std::env::temp_dir().join("diffle-tests-no-global-gitconfig"))
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
}

/// main: a ─ b ─ m ─ e, where m merges side (c ─ d), and every commit but `a` shares one date.
fn merged_repo() -> TestRepo {
    let t = TestRepo::new();
    let tie = "2024-01-01T00:00:00Z";
    t.write("a.txt", "a\n");
    commit_at(&t, "a", "2023-01-01T00:00:00Z");
    t.git(&["checkout", "-q", "-b", "side"]);
    t.write("c.txt", "c\n");
    commit_at(&t, "c\n\nwith a body", tie);
    t.write("d.txt", "d\n");
    commit_at(&t, "d", tie);
    t.git(&["checkout", "-q", "main"]);
    t.write("b.txt", "b\n");
    commit_at(&t, "b", tie);
    t.git(&["merge", "-q", "--no-ff", "-m", "m", "side"]);
    t.write("e.txt", "e\n");
    commit_at(&t, "e", tie);
    t.git(&["tag", "v1", "HEAD~1"]);
    t.git(&["tag", "-a", "-m", "annotated", "v2", "HEAD"]);
    t
}

#[tokio::test]
async fn lists_range_commits_in_git_log_order_through_merges_and_date_ties() {
    let t = merged_repo();
    let repo = t.open().await;
    let root = t.git(&["rev-list", "--max-parents=0", "HEAD"]);
    for range in [format!("{root}..main"), "HEAD^!".to_owned(), "HEAD~1^!".to_owned(), "main~2..side".to_owned()] {
        let listed = repo.range_commits(&range, 100).await.unwrap();
        let git = t.git(&["log", "--reverse", "--format=%H %h %an %ae %at", &range, "--"]);
        let ours: Vec<String> = listed
            .list
            .iter()
            .map(|c| format!("{} {} {} {} {}", c.sha, c.short, c.author, c.email, c.date / 1000))
            .collect();
        assert_eq!(ours.join("\n"), git, "{range}");
        assert_eq!(listed.total.to_string(), t.git(&["rev-list", "--count", &range, "--"]), "{range}");
    }
    let newest = repo.range_commits(&format!("{root}..main"), 2).await.unwrap();
    assert_eq!(newest.total, 5);
    let git = t.git(&["log", "--reverse", "--max-count=2", "--format=%H", &format!("{root}..main")]);
    assert_eq!(newest.list.iter().map(|c| c.sha.as_str()).collect::<Vec<_>>().join("\n"), git);
    let side = repo.range_commits("main~2..side", 10).await.unwrap();
    assert_eq!(side.list.iter().map(|c| c.message.as_str()).collect::<Vec<_>>(), ["c\n\nwith a body", "d"]);
}

#[tokio::test]
async fn finds_neighbours_on_heads_first_parent_line_only() {
    let t = merged_repo();
    let repo = t.open().await;
    let sha = |rev: &str| t.git(&["rev-parse", rev]);
    let at = |rev: &str| {
        let rev = sha(rev);
        let repo = &repo;
        async move { repo.commit_neighbours(&rev).await.unwrap() }
    };
    assert_eq!(at("HEAD~1").await, (Some(sha("HEAD~2")), Some(sha("HEAD"))));
    assert_eq!(at("HEAD").await, (Some(sha("HEAD~1")), None));
    // `d` reached HEAD through the merge's second parent: it has a parent but no child on the line.
    assert_eq!(at("side").await, (Some(sha("side~1")), None));
    assert_eq!(at("HEAD~3").await, (None, Some(sha("HEAD~2"))));
}

#[tokio::test]
async fn resolves_revisions_and_commit_metadata_as_rev_parse_does() {
    let t = merged_repo();
    let repo = t.open().await;
    for rev in ["HEAD", "main~2", "HEAD~1^2", "v1", "v2", ":/with a body", "side@{0}"] {
        // `rev-list` peels to the commit, which `rev^{commit}` cannot spell for `:/<regex>`.
        assert_eq!(repo.resolve(rev).await.unwrap(), t.git(&["rev-list", "-n", "1", rev, "--"]), "{rev}");
    }
    assert!(repo.resolve("nope").await.unwrap_err().is_missing());
    assert!(repo.resolve("HEAD^{tree}").await.unwrap_err().is_missing());
    assert_eq!(repo.tree("v2").await.unwrap(), t.git(&["rev-parse", "HEAD^{tree}"]));
    assert_eq!(repo.merge_base("main~1", "side").await.unwrap(), t.git(&["merge-base", "main~1", "side"]));
    let info = repo.commit_info("side~1").await.unwrap().unwrap();
    assert_eq!(info.short, t.git(&["log", "-1", "--format=%h", "side~1"]));
    assert_eq!(info.message, "c\n\nwith a body");
}

#[tokio::test]
async fn lists_refs_as_for_each_ref_sorts_them() {
    let t = merged_repo();
    t.git(&["branch", "old", "HEAD~3"]);
    t.git(&["update-ref", "refs/remotes/origin/main", "HEAD"]);
    t.git(&["update-ref", "refs/remotes/origin/old", "HEAD~3"]);
    t.git(&["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    let refs = t.open().await.refs().await.unwrap();
    let each = |order: &str, prefix: &str| -> Vec<String> {
        t.git(&["for-each-ref", "--format=%(refname:short)", order, prefix]).lines().map(str::to_owned).collect()
    };
    assert_eq!(refs.branches, each("--sort=-committerdate", "refs/heads"));
    assert_eq!(refs.remote_branches, ["origin/main", "origin/old"]);
    assert_eq!(refs.tags, each("--sort=-creatordate", "refs/tags"));
    assert_eq!(refs.default_branch.as_deref(), Some("origin/main"));
    assert_eq!(refs.current.as_deref(), Some("main"));
    let log = t.git(&["log", "-n", "30", "--format=%H %h %s"]);
    let recent: Vec<String> = refs.recent.iter().map(|c| format!("{} {} {}", c.sha, c.short, c.subject)).collect();
    assert_eq!(recent.join("\n"), log);
}

#[tokio::test]
async fn reads_remotes_and_upstreams_from_config_changed_after_opening() {
    let t = merged_repo();
    let repo = t.open().await;
    assert!(repo.remotes().await.unwrap().is_empty());
    t.git(&["remote", "add", "origin", "https://example.com/a.git"]);
    t.git(&["remote", "add", "fork/x", "git@example.com:b.git"]);
    t.git(&["config", "--add", "remote.origin.url", "https://example.com/second.git"]);
    t.git(&["config", "url.https://mirror/.insteadOf", "https://example.com/"]);
    t.git(&["update-ref", "refs/remotes/fork/x/topic", "HEAD"]);
    t.git(&["branch", "--set-upstream-to", "fork/x/topic", "side"]);
    let remotes: Vec<(String, String)> = repo.remotes().await.unwrap().into_iter().map(|r| (r.name, r.url)).collect();
    assert_eq!(
        remotes,
        [
            ("origin".to_owned(), "https://example.com/a.git".to_owned()),
            ("fork/x".to_owned(), "git@example.com:b.git".to_owned())
        ]
    );
    let upstream = repo.upstream_branch("side").await.unwrap().unwrap();
    assert_eq!((upstream.remote.as_str(), upstream.branch.as_str()), ("fork/x", "topic"));
    let tracking = repo.upstream_branch("fork/x/topic").await.unwrap().unwrap();
    assert_eq!((tracking.remote.as_str(), tracking.branch.as_str()), ("fork/x", "topic"));
    assert_eq!(repo.upstream_branch("main").await.unwrap(), None);
    assert_eq!(repo.branch_ref("side").await.unwrap().as_deref(), Some("refs/heads/side"));
    assert_eq!(repo.branch_ref("v1").await.unwrap(), None);
    assert_eq!(repo.branch_ref("main~1").await.unwrap(), None);
}

#[tokio::test]
async fn pins_and_cleans_only_its_own_refs() {
    let t = merged_repo();
    let repo = t.open().await;
    let head = t.git(&["rev-parse", "HEAD"]);
    let pinned = "refs/diffle/iterations/k/1".to_owned();
    repo.pin(&[(pinned.clone(), Some(head.clone()))]).await.unwrap();
    assert_eq!(t.git(&["rev-parse", &pinned]), head);
    repo.pin(&[(pinned.clone(), None), ("refs/diffle/iterations/never".to_owned(), None)]).await.unwrap();
    assert_eq!(t.git(&["for-each-ref", "refs/diffle"]), "");
    assert!(repo.pin(&[("refs/heads/main".to_owned(), None)]).await.is_err());
    t.git(&["update-ref", &format!("{}/pr/1", repo.review_refs), "HEAD"]);
    t.git(&["update-ref", "refs/diffle/other-instance/pr/1", "HEAD"]);
    repo.clean_review_refs().await.unwrap();
    assert_eq!(t.git(&["for-each-ref", "--format=%(refname)", "refs/diffle"]), "refs/diffle/other-instance/pr/1");
}

#[tokio::test]
async fn hashes_content_and_reads_attributes_as_git_does() {
    let t = TestRepo::new();
    t.write(".gitattributes", "*.txt text eol=crlf\ngen/** linguist-generated\nkeep.py -linguist-generated\n");
    t.write("a.txt", "one\ntwo\n");
    t.commit("attributes");
    t.write(".gitattributes", "*.txt text eol=crlf\n*.py linguist-generated=true\n");
    let repo = t.open().await;
    let crlf = b"one\r\ntwo\r\n";
    let git_hash = {
        let out = Command::new("git")
            .args(["hash-object", "--stdin", "--path=a.txt"])
            .current_dir(&t.path)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        use std::io::Write;
        out.stdin.as_ref().unwrap().write_all(crlf).unwrap();
        String::from_utf8(out.wait_with_output().unwrap().stdout).unwrap().trim().to_owned()
    };
    assert_eq!(repo.hash_object(crlf, "a.txt").await.unwrap(), git_hash);
    // The CRLF worktree file stores as the committed LF blob.
    assert_eq!(git_hash, t.git(&["rev-parse", "HEAD:a.txt"]));
    let paths: Vec<String> = ["gen/x.rs", "keep.py", "a.txt", "b.py"].map(str::to_owned).to_vec();
    let attrs = |rev: &str| {
        let out = t.git(&["check-attr", &format!("--source={rev}"), "linguist-generated", "--", "gen/x.rs", "keep.py"]);
        out.lines().map(str::to_owned).collect::<Vec<_>>()
    };
    let committed = repo.attr("linguist-generated", &paths, "HEAD").await.unwrap();
    assert_eq!(committed, HashMap::from([("gen/x.rs".to_owned(), true), ("keep.py".to_owned(), false)]));
    assert_eq!(attrs("HEAD"), ["gen/x.rs: linguist-generated: set", "keep.py: linguist-generated: unset"]);
    let worktree = repo.attr("linguist-generated", &paths, "worktree").await.unwrap();
    assert_eq!(worktree, HashMap::from([("keep.py".to_owned(), true), ("b.py".to_owned(), true)]));
}

#[tokio::test]
async fn lists_untracked_and_ignored_paths_as_ls_files_others_does() {
    let t = TestRepo::new();
    t.write(".gitignore", "target/\n*.log\n!keep.log\nbuild\n");
    t.write("tracked.log", "tracked though ignored\n");
    t.git(&["add", "-f", "tracked.log"]);
    t.write("a.txt", "a\n");
    t.commit("base");
    t.write("new.txt", "n\n");
    t.write("dir/deep/new.rs", "n\n");
    t.write("dir/debug.log", "x\n");
    t.write("dir/keep.log", "k\n");
    t.write("target/out/bin", "x\n");
    t.write("build", "a file named like an ignored directory\n");
    std::fs::create_dir_all(t.path.join("empty/inner")).unwrap();
    common::git_in(
        &{
            let nested = t.path.join("nested");
            std::fs::create_dir_all(&nested).unwrap();
            nested
        },
        &["init", "-q"],
    );
    #[cfg(unix)]
    std::os::unix::fs::symlink("a.txt", t.path.join("link")).unwrap();
    let repo = t.open().await;
    let lines = |args: &[&str]| -> Vec<String> {
        let mut all = vec!["ls-files", "-z", "--others", "--exclude-standard"];
        all.extend(args);
        let mut out: Vec<String> = t.git(&all).split('\0').filter(|p| !p.is_empty()).map(str::to_owned).collect();
        out.sort();
        out
    };
    assert_eq!(repo.untracked().await.unwrap(), lines(&[]));
    assert_eq!(repo.ignored_paths().await.unwrap(), lines(&["--ignored", "--directory"]));
}

/// `git merge-tree --write-tree --name-only`: the tree, and the conflicted paths.
fn git_merge_tree(t: &TestRepo, base: &str, onto: &str, head: &str) -> (String, Vec<String>) {
    let out = Command::new("git")
        .args(["merge-tree", "--write-tree", "-z", "--name-only", &format!("--merge-base={base}"), onto, head])
        .current_dir(&t.path)
        .output()
        .unwrap();
    let out = String::from_utf8(out.stdout).unwrap();
    let mut parts = out.split('\0');
    let tree = parts.next().unwrap().to_owned();
    (tree, parts.take_while(|p| !p.is_empty()).map(str::to_owned).collect())
}

#[tokio::test]
async fn replays_as_git_merge_tree_does_conflicts_included() {
    let t = TestRepo::new();
    let lines = |tag: &str| (0..40).map(|i| format!("{tag} line {i}\n")).collect::<String>();
    t.write("edit.txt", lines("edit"));
    t.write("moved.txt", lines("moved"));
    t.write("gone.txt", lines("gone"));
    t.write("bin.dat", b"\x00base");
    t.write("same.txt", lines("same"));
    t.commit("base");
    t.git(&["checkout", "-q", "-b", "head"]);
    t.write(
        "edit.txt",
        lines("edit").replace("edit line 5\n", "head five\n").replace("edit line 30\n", "head thirty\n"),
    );
    t.write("moved.txt", lines("moved").replace("moved line 20\n", "head twenty\n"));
    t.write("gone.txt", lines("gone").replace("gone line 1\n", "head one\n"));
    t.write("bin.dat", b"\x00head");
    t.write("both.txt", "head adds\n");
    t.write("clean.txt", "only head\n");
    t.commit("head");
    t.git(&["checkout", "-q", "main"]);
    t.write("edit.txt", lines("edit").replace("edit line 5\n", "onto five\n").replace("edit line 35\n", "onto 35\n"));
    t.git(&["mv", "moved.txt", "renamed.txt"]);
    t.rm("gone.txt");
    t.write("bin.dat", b"\x00onto");
    t.write("both.txt", "onto adds\n");
    t.write("same.txt", lines("same").replace("same line 0\n", "onto zero\n"));
    t.commit("onto");
    let repo = t.open().await;
    let base = t.git(&["rev-parse", "main~1"]);
    for (onto, head) in [("main", "head"), ("head", "main")] {
        let ours = repo.replay(&base, onto, head).await.unwrap();
        assert_eq!(ours, git_merge_tree(&t, &base, onto, head), "{onto} <- {head}");
        assert_eq!(ours.1, ["bin.dat", "both.txt", "edit.txt", "gone.txt"]);
    }
    let clean = repo.replay(&base, "main~1", "head").await.unwrap();
    assert_eq!(clean, git_merge_tree(&t, &base, "main~1", "head"));
    assert!(clean.1.is_empty());
}

/// `git grep -n -I -z` matches as `(path, line, text)`, every one of them.
fn git_grep(dir: &std::path::Path, query: &str, rev: &str, flags: &[&str]) -> Vec<(String, i64, String)> {
    let mut args = vec!["grep", "-n", "--no-column", "-I", "-z"];
    args.extend(flags);
    args.extend(["-e", query, if rev == "worktree" { "--untracked" } else { rev }, "--"]);
    let out = Command::new("git").args(&args).current_dir(dir).output().unwrap();
    String::from_utf8_lossy(&out.stdout)
        .split_terminator('\n')
        .map(|record| {
            let mut f = record.splitn(3, '\0');
            let path = f.next().unwrap();
            let path = if rev == "worktree" { path } else { path.split_once(':').unwrap().1 };
            (path.to_owned(), f.next().unwrap().parse().unwrap(), f.next().unwrap().chars().take(300).collect())
        })
        .collect()
}

async fn assert_grep(dir: &std::path::Path, repo: &diffle::git::GitRepo, query: &str, rev: &str, flags: &[&str]) {
    let opts = diffle::git::GrepOptions {
        word: flags.contains(&"-w"),
        ignore_case: flags.contains(&"-i"),
        regex: flags.contains(&"-E"),
        ..Default::default()
    };
    let result = repo.grep(query, rev, 100_000, opts).await.unwrap();
    let ours: Vec<_> = result.matches.into_iter().map(|m| (m.path, m.line, m.text)).collect();
    let mut git_flags = flags.to_vec();
    if !flags.contains(&"-E") {
        git_flags.push("-F");
    }
    let mut theirs = git_grep(dir, query, rev, &git_flags);
    // A capped search is git's first matches, flagged as cut.
    assert_eq!(result.truncated, theirs.len() > ours.len(), "{query} {flags:?} in {rev}: truncation");
    theirs.truncate(ours.len());
    if ours != theirs {
        let at = ours.iter().zip(&theirs).position(|(a, b)| a != b).unwrap_or(ours.len().min(theirs.len()));
        panic!(
            "{query} {flags:?} in {rev}: {} vs {} matches, first difference at {at}:\nours {:?}\ngit  {:?}",
            ours.len(),
            theirs.len(),
            ours.get(at),
            theirs.get(at)
        );
    }
}

#[tokio::test]
async fn searches_as_git_grep_does() {
    let t = TestRepo::new();
    t.write("a.txt", "one two\nfoo_bar foo\r\n-x x- -x-\nTwo\n");
    t.write("dir/b.rs", "fn foo() {}\nlet foo2 = foo;\n");
    t.write("bin.dat", b"foo\x00");
    t.write(".gitattributes", "*.lock -diff\n");
    t.write("deps.lock", "foo\n");
    t.commit("base");
    t.write("a.txt", "one two\nfoo changed\n");
    t.write("new.txt", "untracked foo\n");
    let repo = t.open().await;
    for rev in ["HEAD", "worktree"] {
        for (query, flags) in [
            ("foo", &[][..]),
            ("foo", &["-w"]),
            ("-x", &["-w"]),
            ("two", &["-i"]),
            ("fo+(_bar)?", &["-E"]),
            ("^let|\\}$", &["-E", "-w"]),
            ("o", &[]),
        ] {
            assert_grep(&t.path, &repo, query, rev, flags).await;
        }
    }
}

/// `DIFFLE_PARITY_REPO=<dir> cargo test --test gix_parity -- --ignored grep`.
#[tokio::test]
#[ignore]
async fn searches_a_real_repository_as_git_grep_does() {
    let dir = std::path::PathBuf::from(std::env::var("DIFFLE_PARITY_REPO").expect("DIFFLE_PARITY_REPO"));
    let repo = diffle::git::GitRepo::open(&dir).await.unwrap();
    for rev in ["HEAD", "worktree"] {
        for (query, flags) in
            [("fn", &["-w"][..]), ("self", &["-i"]), ("[A-Z][a-z]+Error", &["-E"]), ("TODO", &[]), ("::", &["-w"])]
        {
            assert_grep(&dir, &repo, query, rev, flags).await;
        }
    }
}

/// Over the network: a pull request ref fetched from GitHub, and a clone over https.
/// `DIFFLE_PARITY_REPO=<a clone of github.com/BurntSushi/ripgrep> cargo test -- --ignored network`.
#[tokio::test]
#[ignore]
async fn fetches_and_clones_over_https() {
    let dir = std::path::PathBuf::from(std::env::var("DIFFLE_PARITY_REPO").expect("DIFFLE_PARITY_REPO"));
    let repo = diffle::git::GitRepo::open(&dir).await.unwrap();
    let dst = format!("{}/pr/100/head", repo.review_refs);
    repo.fetch("origin", &[format!("+refs/pull/100/head:{dst}")]).await.unwrap();
    assert_eq!(
        repo.resolve(&dst).await.unwrap(),
        common::git_in(&dir, &["ls-remote", "origin", "refs/pull/100/head"]).split('\t').next().unwrap()
    );
    repo.clean_review_refs().await.unwrap();
    let target = tempfile::tempdir().unwrap();
    let clone =
        diffle::git::GitRepo::clone_into("https://github.com/octocat/Hello-World", target.path()).await.unwrap();
    assert_eq!(clone.resolve("HEAD").await.unwrap(), common::git_in(target.path(), &["rev-parse", "origin/master"]));
    assert_eq!(common::git_in(target.path(), &["status", "--porcelain"]), "");
    assert!(target.path().join("README").exists());
}
