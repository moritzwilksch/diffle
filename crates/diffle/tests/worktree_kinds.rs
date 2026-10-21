//! A worktree with a submodule, a broken symlink and a nested repository; gitattributes.
mod common;

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use common::{TestRepo, git_in, revspec, snapshot};
use diffle::protocol::{ChangeStatus::*, EnterRequest};

/// `super` records `sub` at an older commit than its checkout; beside it an edit, a staged broken
/// symlink and an untracked nested repository.
fn super_repo() -> (TestRepo, TestRepo) {
    let lib = TestRepo::new();
    lib.write("l.txt", "one\n");
    lib.commit("lib base");
    let sup = TestRepo::new();
    sup.write("a.txt", "a\n");
    sup.commit("base");
    let url = lib.path.to_string_lossy().replace('\\', "/");
    sup.git(&["-c", "protocol.file.allow=always", "submodule", "add", "-q", &url, "sub"]);
    sup.git(&["commit", "-q", "-m", "add sub"]);
    sup.write("sub/l.txt", "one\ntwo\n");
    git_in(&sup.path.join("sub"), &["commit", "-q", "-am", "bump"]);
    sup.write("a.txt", "a\nb\n");
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("nowhere", sup.path.join("broken.lnk")).unwrap();
        sup.git(&["add", "broken.lnk"]);
    }
    std::fs::create_dir(sup.path.join("nested")).unwrap();
    git_in(&sup.path.join("nested"), &["init", "-q"]);
    sup.write("nested/n.txt", "n\n");
    (lib, sup)
}

#[cfg(unix)]
#[tokio::test]
async fn numstat_loads_every_ordinary_file_and_marks_the_gitlink() {
    let (_lib, sup) = super_repo();
    let repo = sup.open().await;
    let files = repo.numstat("HEAD", "worktree").await.unwrap();
    let rows: Vec<_> = files.iter().map(|f| (f.path.as_str(), f.status, f.additions, f.deletions)).collect();
    assert_eq!(rows, [("a.txt", M, 1, 0), ("broken.lnk", A, 1, 0), ("sub", M, 1, 1)]);
    let by: HashMap<&str, _> = files.iter().map(|f| (f.path.as_str(), f)).collect();
    assert_eq!(by["a.txt"].blob, sup.git(&["hash-object", "--", "a.txt"]));
    assert_eq!(by["a.txt"].submodule, None);
    // A symlink's blob is its target string, the same sha the index holds.
    assert_eq!(by["broken.lnk"].blob, sup.git(&["ls-files", "-s", "broken.lnk"]).split_whitespace().nth(1).unwrap());
    // The gitlink's "blob" is the commit the submodule is checked out at.
    assert_eq!(
        (by["sub"].submodule, by["sub"].blob.clone()),
        (Some(true), git_in(&sup.path.join("sub"), &["rev-parse", "HEAD"]))
    );
    let committed = repo.numstat("HEAD~1", "HEAD").await.unwrap();
    let rows: Vec<_> = committed.iter().map(|f| (f.path.as_str(), f.status, f.submodule)).collect();
    assert_eq!(rows, [(".gitmodules", A, None), ("sub", A, Some(true))]);
}

#[tokio::test]
async fn renders_a_gitlink_as_a_commit_id_change_and_leaves_it_out_of_hydration() {
    let (_lib, sup) = super_repo();
    let repo = Arc::new(sup.open().await);
    let (snapshotter, snap) = snapshot(&repo, EnterRequest::Working).await;
    assert!(snap.changed.iter().any(|f| f.path == "sub"));
    assert!(snap.tree.contains(&"sub".to_owned()));
    assert!(!snap.tree.iter().any(|p| p.starts_with("nested")));
    let sub = snap.changed.iter().find(|f| f.path == "sub").unwrap();
    assert_eq!((sub.submodule, sub.generated), (Some(true), false));
    let patch = snapshotter.patch("sub").await.unwrap().unwrap();
    assert!(patch.contains("-Subproject commit ") && patch.contains("+Subproject commit "), "{patch}");
    assert!(snapshotter.patch_all().await.unwrap().contains("+b\n"));
    // Not a file on either side: the read reports absence instead of failing.
    assert!(repo.read_worktree("sub").await.unwrap().is_none());
}

// `chmod 0` cannot make a read fail on Windows, nor for root.
#[cfg(unix)]
#[tokio::test]
async fn an_unreadable_file_keeps_an_empty_blob_without_failing_the_batch() {
    use std::os::unix::fs::PermissionsExt;
    let (_lib, sup) = super_repo();
    sup.write("locked.txt", "x\n");
    let locked = sup.path.join("locked.txt");
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    if std::fs::read(&locked).is_ok() {
        return; // running as root
    }
    let files = sup.open().await.numstat("HEAD", "worktree").await.unwrap();
    let by: HashMap<&str, _> = files.iter().map(|f| (f.path.as_str(), f)).collect();
    assert_eq!((by["locked.txt"].status, by["locked.txt"].blob.as_str()), (A, ""));
    assert_eq!(by["a.txt"].blob, sup.git(&["hash-object", "--", "a.txt"]));
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o644)).unwrap();
}

const ODD: &str = "completions/odd\nname.bash";
const FILES: [&str; 5] = ["completions/x.bash", "src/bare.ts", "src/off.ts", "src/main.ts", "package-lock.json"];

fn attr_repo() -> TestRepo {
    let t = TestRepo::new();
    t.write(
        ".gitattributes",
        "completions/** merge=binary linguist-generated=true\nsrc/bare.ts linguist-generated\nsrc/off.ts -linguist-generated\npackage-lock.json linguist-generated=false\n",
    );
    t.write("completions/x.bash", "complete -F _x x\n");
    t.write("src/bare.ts", "export {};\n");
    t.write("src/off.ts", "export {};\n");
    t.write("src/main.ts", "export {};\n");
    t.write("package-lock.json", "{}\n");
    if cfg!(unix) {
        t.write(ODD, "odd\n");
    }
    t.commit("base");
    t.git(&["checkout", "-q", "-b", "feat"]);
    for path in FILES {
        let before = std::fs::read_to_string(t.path.join(path)).unwrap();
        t.write(path, before + "// more\n");
    }
    if cfg!(unix) {
        t.write(ODD, "odd\nmore\n");
    }
    t.git(&["commit", "-q", "-am", "feat"]);
    t
}

#[tokio::test]
async fn reads_set_unset_and_valued_attributes_and_leaves_unspecified_paths_out() {
    let t = attr_repo();
    let repo = t.open().await;
    let mut paths: Vec<String> = FILES.iter().map(|p| (*p).to_owned()).collect();
    let mut expected = HashMap::from([
        ("completions/x.bash".to_owned(), true),
        ("src/bare.ts".to_owned(), true),
        ("src/off.ts".to_owned(), false),
        ("package-lock.json".to_owned(), false),
    ]);
    if cfg!(unix) {
        paths.push(ODD.into());
        expected.insert(ODD.into(), true);
    }
    assert_eq!(repo.attr("linguist-generated", &paths, "worktree").await.unwrap(), expected);
    assert_eq!(repo.attr("linguist-generated", &paths, "feat").await.unwrap(), expected);
    assert!(repo.attr("linguist-generated", &[], "worktree").await.unwrap().is_empty());
}

#[tokio::test]
async fn the_attribute_decides_generated_before_path_and_content_heuristics() {
    let t = attr_repo();
    let repo = Arc::new(t.open().await);
    let (_, snap) = snapshot(&repo, revspec(&["main..feat"])).await;
    let flags: BTreeMap<&str, bool> = snap.changed.iter().map(|f| (f.path.as_str(), f.generated)).collect();
    let mut expected = BTreeMap::from([
        ("completions/x.bash", true),
        ("src/bare.ts", true),
        ("src/off.ts", false),
        ("src/main.ts", false),
        // `=false` opts a lockfile out of the built-in path convention.
        ("package-lock.json", false),
    ]);
    if cfg!(unix) {
        expected.insert(ODD, true);
    }
    assert_eq!(flags, expected);
}

#[tokio::test]
async fn a_committed_comparison_reads_attributes_from_the_new_revision_the_worktree_from_the_checkout() {
    let t = attr_repo();
    // Flip the checkout copy only: `feat` still carries the original.
    t.write(".gitattributes", "completions/** -linguist-generated\n");
    let repo = Arc::new(t.open().await);
    let (_, committed) = snapshot(&repo, revspec(&["main..feat"])).await;
    let flag =
        |snap: &diffle::protocol::Snapshot, path: &str| snap.changed.iter().find(|f| f.path == path).unwrap().generated;
    assert!(flag(&committed, "completions/x.bash"));
    assert!(!flag(&committed, "package-lock.json"));
    t.write("completions/x.bash", "edited\n");
    let (_, live) = snapshot(&repo, EnterRequest::Working).await;
    assert!(!flag(&live, "completions/x.bash"));
}
