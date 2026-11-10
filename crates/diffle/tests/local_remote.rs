//! Fetching from and cloning a repository on disk: what lands in the object store, as git checks it.
mod common;

use common::{TestRepo, git_in};
use diffle::git::GitRepo;

/// A history of a few commits, part packed and part loose, an annotated tag, and a tag of a tree.
fn source() -> TestRepo {
    let s = TestRepo::new();
    s.write("a.txt", "one\n");
    s.write("dir/b.txt", "b\n");
    s.commit("base");
    s.write("a.txt", "one\ntwo\n");
    s.commit("two");
    s.git(&["branch", "older"]);
    s.git(&["gc", "-q"]);
    s.write("dir/c.txt", "c\n");
    s.commit("three");
    s.git(&["tag", "-a", "-m", "release", "v1"]);
    let tree = s.git(&["rev-parse", "HEAD^{tree}"]);
    s.git(&["tag", "-a", "-m", "a tree", "t1", &tree]);
    s
}

/// The object store's counts, `git count-objects -v`'s `count` (loose) and `packs`.
fn objects(dir: &std::path::Path) -> (u64, u64) {
    let out = git_in(dir, &["count-objects", "-v"]);
    let field = |name: &str| {
        out.lines().find_map(|l| l.strip_prefix(&format!("{name}: "))).and_then(|v| v.parse().ok()).unwrap()
    };
    (field("count"), field("packs"))
}

fn keep_files(dir: &std::path::Path) -> usize {
    std::fs::read_dir(dir.join(".git/objects/pack"))
        .unwrap()
        .filter(|e| e.as_ref().unwrap().path().extension().is_some_and(|x| x == "keep"))
        .count()
}

#[tokio::test]
async fn fetches_what_is_missing_as_one_pack_git_accepts() {
    let s = source();
    let t = TestRepo::new();
    t.git(&["remote", "add", "up", s.path.to_str().unwrap()]);
    let repo = t.open().await;
    let specs = [
        "+refs/heads/older:refs/diffle/x/old".to_owned(),
        "+refs/tags/v1:refs/diffle/x/v1".to_owned(),
        "+refs/tags/t1:refs/diffle/x/t1".to_owned(),
    ];
    repo.fetch("up", &specs[..1]).await.unwrap();
    repo.fetch("up", &specs[1..]).await.unwrap();
    assert_eq!(objects(&t.path), (0, 2), "one pack per fetch, nothing loose");
    assert_eq!(keep_files(&t.path), 0, "the refs reach the packs, so none is kept");
    git_in(&t.path, &["fsck", "--full", "--strict", "--no-dangling"]);
    assert_eq!(t.git(&["rev-parse", "refs/diffle/x/v1^{commit}"]), s.git(&["rev-parse", "main"]));
    assert_eq!(t.git(&["cat-file", "-t", "refs/diffle/x/t1^{}"]), "tree");
    // Nothing missing, nothing written.
    repo.fetch("up", &specs).await.unwrap();
    assert_eq!(objects(&t.path), (0, 2));
}

#[tokio::test]
async fn fetching_a_tag_alone_brings_its_commits_history() {
    let s = source();
    let t = TestRepo::new();
    t.git(&["remote", "add", "up", s.path.to_str().unwrap()]);
    let repo = t.open().await;
    repo.fetch("up", &["+refs/tags/v1:refs/diffle/x/v1".to_owned()]).await.unwrap();
    git_in(&t.path, &["fsck", "--full", "--strict", "--no-dangling"]);
    assert_eq!(t.git(&["rev-list", "--count", "refs/diffle/x/v1"]), "3");
    assert_eq!(objects(&t.path), (0, 1));
}

#[tokio::test]
async fn clones_a_repository_on_disk_by_linking_its_objects() {
    let s = source();
    let dir = tempfile::tempdir().unwrap();
    let clone = dir.path().join("clone");
    let repo = GitRepo::clone_into(s.path.to_str().unwrap(), &clone).await.unwrap();
    assert_eq!(repo.resolve("HEAD").await.unwrap(), s.git(&["rev-parse", "main"]));
    assert_eq!(std::fs::read_to_string(clone.join("dir/c.txt")).unwrap(), "c\n");
    assert_eq!(objects(&clone), objects(&s.path), "the source's packs and loose objects, as they are");
    git_in(&clone, &["fsck", "--full", "--strict", "--no-dangling"]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let pack = |root: &std::path::Path| {
            let dir = root.join(".git/objects/pack");
            let file = std::fs::read_dir(&dir)
                .unwrap()
                .map(|e| e.unwrap().path())
                .find(|p| p.extension().is_some_and(|x| x == "pack"))
                .unwrap();
            std::fs::metadata(file).unwrap().ino()
        };
        assert_eq!(pack(&clone), pack(&s.path), "linked, not copied");
    }
}

#[tokio::test]
async fn a_clone_keeps_its_sources_alternates_reachable() {
    let base = source();
    let s = TestRepo::new();
    let objects_dir = base.path.join(".git/objects");
    std::fs::write(s.path.join(".git/objects/info/alternates"), format!("{}\n", objects_dir.display())).unwrap();
    s.git(&["fetch", "-q", base.path.to_str().unwrap(), "main:imported"]);
    s.git(&["checkout", "-q", "imported"]);
    let dir = tempfile::tempdir().unwrap();
    let clone = dir.path().join("clone");
    GitRepo::clone_into(s.path.to_str().unwrap(), &clone).await.unwrap();
    git_in(&clone, &["fsck", "--full", "--no-dangling"]);
    assert_eq!(std::fs::read_to_string(clone.join("a.txt")).unwrap(), "one\ntwo\n");
}
