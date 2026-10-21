mod common;

use std::sync::Arc;

use common::server::TestServer;
use common::{TestRepo, revspec};
use diffle::protocol::{EnterRequest, Side, image_key};
use diffle::session::Session;

const PNG: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

fn png(tag: u8) -> Vec<u8> {
    [&PNG[..], &[0, 0, 0, tag]].concat()
}

/// logo.png changes and before.png is renamed on feat; still.png stays; blob.png is no image.
fn image_repo() -> TestRepo {
    let t = TestRepo::new();
    t.write("logo.png", png(1));
    t.write("before.png", png(3));
    t.write("still.png", png(5));
    t.write("blob.png", [0u8, 1, 2, 3]);
    t.write(".gitignore", "ignored.png\n");
    t.commit("base");
    t.git(&["checkout", "-q", "-b", "feat"]);
    t.write("logo.png", png(2));
    t.git(&["mv", "before.png", "after.png"]);
    t.git(&["commit", "-q", "-am", "change"]);
    t.write("ignored.png", png(4));
    t
}

fn path(file: &str, rev: Side, key: &str) -> String {
    let rev = if rev == Side::New { "new" } else { "old" };
    let query: String = form_urlencoded::Serializer::new(String::new())
        .append_pair("path", file)
        .append_pair("rev", rev)
        .append_pair("key", key)
        .finish();
    format!("/api/image?{query}")
}

async fn image(s: &TestServer, file: &str, rev: Side, key: &str) -> reqwest::Response {
    s.fetch(&path(file, rev, key)).await
}

/// Requests a side under the key the current snapshot gives it, as the client does.
async fn current(s: &TestServer, file: &str, rev: Side) -> reqwest::Response {
    let snap = s.session.snapshotter().unwrap().current().await.unwrap();
    image(s, file, rev, &image_key(&snap, file, rev).unwrap_or_default()).await
}

async fn bytes(res: reqwest::Response) -> Vec<u8> {
    assert_eq!(res.status(), 200, "{}", res.url());
    res.bytes().await.unwrap().to_vec()
}

/// Waits out the snapshot's patch prewarm: on Windows a `git diff` still reading a worktree file
/// makes rewriting it fail.
async fn settle(session: &Arc<Session>) {
    let snapshotter = session.snapshotter().unwrap();
    let snap = snapshotter.current().await.unwrap();
    snapshotter.patch_many(&snap.changed.iter().map(|f| f.path.clone()).collect::<Vec<_>>()).await.unwrap();
}

async fn switch(s: &TestServer, req: EnterRequest) {
    s.session.enter(req).await.unwrap();
    settle(&s.session).await;
}

#[tokio::test]
async fn serves_each_side_of_a_changed_image_under_its_blob_as_its_sniffed_type_for_good() {
    let t = image_repo();
    let main = t.git(&["rev-parse", "main:logo.png"]);
    let feat = t.git(&["rev-parse", "feat:logo.png"]);
    let s = TestServer::over(t, revspec(&["main..feat"])).await;
    for (rev, key, tag) in [(Side::Old, &main, 1), (Side::New, &feat, 2)] {
        let res = image(&s, "logo.png", rev, key).await;
        let header = |name: &str| res.headers().get(name).unwrap().to_str().unwrap().to_owned();
        assert_eq!(header("content-type"), "image/png");
        assert_eq!(header("cache-control"), "private, max-age=31536000, immutable");
        assert_eq!(header("x-content-type-options"), "nosniff");
        assert_eq!(header("cross-origin-resource-policy"), "same-origin");
        assert_eq!(bytes(res).await, png(tag));
    }
    s.close().await;
}

#[tokio::test]
async fn reads_a_renames_old_side_from_its_old_path_and_an_unchanged_path_under_its_commit() {
    let t = image_repo();
    let feat = t.git(&["rev-parse", "feat"]);
    let s = TestServer::over(t, revspec(&["main..feat"])).await;
    assert_eq!(bytes(current(&s, "after.png", Side::Old).await).await, png(3));
    assert_eq!(bytes(image(&s, "still.png", Side::New, &feat).await).await, png(5));
    s.close().await;
}

#[tokio::test]
async fn answers_404_for_a_key_that_is_not_the_sides_bytes_that_are_no_image_and_paths_outside_the_snapshot() {
    let t = image_repo();
    let feat_logo = t.git(&["rev-parse", "feat:logo.png"]);
    let main = t.git(&["rev-parse", "main"]);
    let s = TestServer::over(t, revspec(&["main..feat"])).await;
    assert_eq!(image(&s, "logo.png", Side::Old, &feat_logo).await.status(), 404);
    assert_eq!(image(&s, "still.png", Side::New, &main).await.status(), 404);
    for file in ["blob.png", "ignored.png", "before.png", ".git/HEAD"] {
        assert_eq!(current(&s, file, Side::New).await.status(), 404, "{file}");
    }
    s.close().await;
}

#[tokio::test]
async fn serves_a_worktree_side_only_while_its_bytes_are_the_snapshots() {
    let t = image_repo();
    t.write("logo.png", png(6));
    let s = TestServer::over(t, EnterRequest::Working).await;
    settle(&s.session).await;
    let snap = s.session.snapshotter().unwrap().current().await.unwrap();
    let key = image_key(&snap, "logo.png", Side::New).unwrap();
    assert_eq!(bytes(image(&s, "logo.png", Side::New, &key).await).await, png(6));
    // No refresh yet: the key still names the old bytes, so the new ones must not be served under it.
    s.repo.write("logo.png", png(7));
    assert_eq!(image(&s, "logo.png", Side::New, &key).await.status(), 404);
    s.close().await;
}

#[tokio::test]
async fn reads_an_unchanged_path_from_the_commit_its_key_names_not_from_a_worktree_that_moved_on() {
    let s = TestServer::over(image_repo(), EnterRequest::Working).await;
    settle(&s.session).await;
    s.repo.write("still.png", png(8));
    let head = s.repo.git(&["rev-parse", "HEAD"]);
    assert_eq!(bytes(image(&s, "still.png", Side::New, &head).await).await, png(5));
    s.close().await;
}

#[tokio::test]
async fn keys_a_worktree_old_side_by_its_hashed_blob() {
    let t = image_repo();
    t.write("logo.png", png(9));
    let s = TestServer::over(t, EnterRequest::Working).await;
    switch(&s, revspec(&["worktree..HEAD"])).await;
    let snap = s.session.snapshotter().unwrap().current().await.unwrap();
    assert_eq!(image_key(&snap, "logo.png", Side::Old).unwrap(), s.repo.git(&["hash-object", "logo.png"]));
    assert_eq!(bytes(current(&s, "logo.png", Side::Old).await).await, png(9));
    assert_eq!(bytes(current(&s, "logo.png", Side::New).await).await, png(2));
    s.close().await;
}
