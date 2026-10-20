mod common;

use std::path::Path;

use diffle::comments::import::parse_imports;
use diffle::comments::{AnchorSource, CommentStore, ReviewView, SideView};
use diffle::error::{Error, Result};
use diffle::protocol::{CommentAnchor, CommentThread, Side, ThreadCreate, ThreadQuery, ThreadState, ViewedEntry};
use serde_json::{Value, json};

fn anchor() -> CommentAnchor {
    CommentAnchor::Line { path: "a.py".into(), side: Side::New, start_line: 2, end_line: 2, quoted: "b".into() }
}

fn file_anchor() -> CommentAnchor {
    CommentAnchor::File { path: "a.py".into() }
}

fn all() -> ThreadQuery {
    ThreadQuery { path: None, state: None }
}

fn imports(value: Value) -> Vec<ThreadCreate> {
    parse_imports(&value).unwrap()
}

fn start(t: &CommentThread) -> i64 {
    match t.anchor {
        CommentAnchor::Line { start_line, .. } => start_line,
        CommentAnchor::File { .. } => 0,
    }
}

fn first_body(t: &CommentThread) -> &str {
    &t.messages[0].body
}

fn raw(dir: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(dir.join("diffle/comments.json")).unwrap()).unwrap()
}

fn entry(path: &str, blob: &str, viewed: bool) -> ViewedEntry {
    ViewedEntry { path: path.into(), blob: blob.into(), viewed }
}

type Mark = (String, String, bool);

fn marks(entries: Vec<ViewedEntry>) -> Vec<Mark> {
    entries.into_iter().map(|e| (e.path, e.blob, e.viewed)).collect()
}

fn mark(path: &str, blob: &str, viewed: bool) -> Mark {
    (path.into(), blob.into(), viewed)
}

/// A review where every file exists and each side reads as `contents`, shown whole unless `shown`.
struct Whole(&'static str, Option<Vec<(i64, i64)>>);

impl ReviewView for Whole {
    async fn side(&self, _: &str, _: Side) -> Result<Option<SideView>> {
        Ok(Some(SideView { contents: self.0.into(), shown: self.1.clone() }))
    }
    fn has_file(&self, _: &str) -> bool {
        true
    }
}

/// A review with no readable sides, holding the file or not.
struct Files(bool);

impl ReviewView for Files {
    async fn side(&self, _: &str, _: Side) -> Result<Option<SideView>> {
        Ok(None)
    }
    fn has_file(&self, _: &str) -> bool {
        self.0
    }
}

/// Quotes `L<start>-<end>` for a.py up to line 3; has only a.py.
struct Quotes;

impl AnchorSource for Quotes {
    async fn quote(&self, path: &str, _: Side, start: i64, end: i64) -> Result<Option<String>> {
        Ok((path == "a.py" && end <= 3).then(|| format!("L{start}-{end}")))
    }
    async fn has_file(&self, path: &str) -> Result<bool> {
        Ok(path == "a.py")
    }
}

/// Every quote reads "from snapshot" for a.py; no file is in the review.
struct Fixed;

impl AnchorSource for Fixed {
    async fn quote(&self, path: &str, _: Side, _: i64, _: i64) -> Result<Option<String>> {
        Ok((path == "a.py").then(|| "from snapshot".into()))
    }
    async fn has_file(&self, _: &str) -> Result<bool> {
        Ok(false)
    }
}

#[tokio::test]
async fn persists_threads_per_mode_key_and_reloads_them() {
    let dir = tempfile::tempdir().unwrap();
    let s1 = CommentStore::open(dir.path(), "working").await.unwrap();
    let t = s1.add_thread(anchor(), "hello".into()).await.unwrap();
    assert!(!t.id.is_empty());
    assert_eq!(first_body(&t), "hello");
    let s2 = CommentStore::open(dir.path(), "working").await.unwrap();
    assert_eq!(serde_json::to_value(s2.threads(&all()).await.unwrap()).unwrap(), json!([t]));
    let other = CommentStore::open(dir.path(), "pr:abc").await.unwrap();
    assert!(other.threads(&all()).await.unwrap().is_empty());
    let raw = raw(dir.path());
    assert_eq!(raw["version"], 3);
    assert_eq!(raw["sets"].as_object().unwrap().keys().collect::<Vec<_>>(), ["working"]);
}

// Quoted source lines are owner-only. Windows has no POSIX mode bits to check.
#[cfg(unix)]
#[tokio::test]
async fn writes_the_comment_file_and_its_directory_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let store = CommentStore::open(dir.path(), "working").await.unwrap();
    store.add_thread(anchor(), "hello".into()).await.unwrap();
    let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&dir.path().join("diffle/comments.json")), 0o600);
    assert_eq!(mode(&dir.path().join("diffle")), 0o700);
}

#[tokio::test]
async fn reads_an_older_format_as_an_empty_store_and_replaces_it_on_the_next_write() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("diffle")).unwrap();
    let v2 = json!({ "version": 2, "sets": { "working": { "threads": [], "viewed": [{ "path": "a.py", "blob": "sha", "viewed": true }] } } });
    std::fs::write(dir.path().join("diffle/comments.json"), v2.to_string()).unwrap();
    let s = CommentStore::open(dir.path(), "working").await.unwrap();
    assert!(s.viewed().await.unwrap().is_empty());
    s.add_thread(anchor(), "hello".into()).await.unwrap();
    assert_eq!(raw(dir.path())["version"], 3);
}

#[tokio::test]
async fn replies_edits_removes_messages_and_threads_resolves_and_clears() {
    let dir = tempfile::tempdir().unwrap();
    let s = CommentStore::open(dir.path(), "working").await.unwrap();
    let t = s.add_thread(anchor(), "hello".into()).await.unwrap();
    s.reply(&t.id, "fixed".into()).await.unwrap();
    let got = s.get(&t.id).await.unwrap().unwrap();
    assert_eq!(got.messages.iter().map(|m| m.body.as_str()).collect::<Vec<_>>(), ["hello", "fixed"]);
    let (first, second) = (got.messages[0].id.clone(), got.messages[1].id.clone());
    s.edit_message(&t.id, &first, "hello again".into()).await.unwrap();
    assert_eq!(first_body(&s.get(&t.id).await.unwrap().unwrap()), "hello again");
    assert_eq!(s.remove_message(&t.id, &second).await.unwrap().unwrap().id, t.id);
    assert_eq!(s.get(&t.id).await.unwrap().unwrap().messages.len(), 1);
    s.set_resolved(&t.id, true).await.unwrap();
    let resolved = s.get(&t.id).await.unwrap().unwrap();
    assert!(resolved.resolved && resolved.resolved_at.is_some());
    let by_state = |state| ThreadQuery { path: None, state: Some(state) };
    assert!(s.threads(&by_state(ThreadState::Open)).await.unwrap().is_empty());
    assert_eq!(s.threads(&by_state(ThreadState::Resolved)).await.unwrap().len(), 1);
    s.set_resolved(&t.id, false).await.unwrap();
    assert!(s.get(&t.id).await.unwrap().unwrap().resolved_at.is_none());
    // The last message takes the thread with it.
    assert!(s.remove_message(&t.id, &first).await.unwrap().is_none());
    assert!(s.threads(&all()).await.unwrap().is_empty());
    assert!(matches!(s.remove_thread(&t.id).await, Err(Error::NotFound(_))));
    assert!(matches!(s.reply("nope", "x".into()).await, Err(Error::NotFound(_))));
    assert!(matches!(s.edit_message("nope", "m", "x".into()).await, Err(Error::NotFound(_))));
    s.add_thread(anchor(), "hello".into()).await.unwrap();
    s.clear().await.unwrap();
    assert!(s.threads(&all()).await.unwrap().is_empty());
}

#[tokio::test]
async fn filters_by_path() {
    let dir = tempfile::tempdir().unwrap();
    let s = CommentStore::open(dir.path(), "working").await.unwrap();
    let z =
        CommentAnchor::Line { path: "z.py".into(), side: Side::New, start_line: 1, end_line: 1, quoted: "b".into() };
    s.add_thread(z, "z".into()).await.unwrap();
    s.add_thread(anchor(), "a".into()).await.unwrap();
    let only = s.threads(&ThreadQuery { path: Some("z.py".into()), state: None }).await.unwrap();
    assert_eq!(only.iter().map(first_body).collect::<Vec<_>>(), ["z"]);
}

#[tokio::test]
async fn imports_payloads_quoting_from_the_snapshot_and_skipping_open_duplicates() {
    let dir = tempfile::tempdir().unwrap();
    let s = CommentStore::open(dir.path(), "working").await.unwrap();
    let (added, skipped) =
        s.import_threads(imports(json!({ "path": "a.py", "startLine": 1, "body": "one" })), &Quotes).await.unwrap();
    assert_eq!(skipped, 0);
    let expected =
        json!({ "kind": "line", "path": "a.py", "side": "new", "startLine": 1, "endLine": 1, "quoted": "L1-1" });
    assert_eq!(serde_json::to_value(&added[0].anchor).unwrap(), expected);
    assert_eq!(first_body(&added[0]), "one");
    let batch = json!([
        { "path": "a.py", "startLine": 1, "body": "one" },
        { "path": "a.py", "startLine": 2, "endLine": 3, "body": "two", "quoted": "given" },
        { "path": "a.py", "startLine": 2, "endLine": 3, "body": "two" },
    ]);
    let (second, skipped) = s.import_threads(imports(batch), &Quotes).await.unwrap();
    assert_eq!(skipped, 2);
    assert!(matches!(&second[..], [t] if matches!(&t.anchor, CommentAnchor::Line { quoted, .. } if quoted == "given")));
    // A resolved thread no longer counts as a duplicate.
    s.set_resolved(&added[0].id, true).await.unwrap();
    let again =
        s.import_threads(imports(json!({ "path": "a.py", "startLine": 1, "body": "one" })), &Quotes).await.unwrap();
    assert_eq!(again.0.len(), 1);
    // An unquotable range adds nothing from the batch.
    let bad =
        json!([{ "path": "a.py", "startLine": 1, "body": "new" }, { "path": "a.py", "startLine": 8, "body": "x" }]);
    let err = s.import_threads(imports(bad), &Quotes).await.unwrap_err();
    assert!(matches!(&err, Error::Unquotable(m) if m == "cannot quote a.py:8 on the new side"), "{err}");
    assert!(!s.threads(&all()).await.unwrap().iter().any(|t| first_body(t) == "new"));
}

#[tokio::test]
async fn imports_a_payload_without_a_line_as_a_thread_on_the_whole_file_when_the_review_has_it() {
    let dir = tempfile::tempdir().unwrap();
    let s = CommentStore::open(dir.path(), "working").await.unwrap();
    let (added, _) =
        s.import_threads(imports(json!({ "path": "a.py", "body": "Split this module." })), &Quotes).await.unwrap();
    assert!(matches!(&added[0].anchor, CommentAnchor::File { path } if path == "a.py"));
    assert!(!added[0].stale);
    let err = s.import_threads(imports(json!({ "path": "gone.py", "body": "x" })), &Quotes).await.unwrap_err();
    assert!(matches!(&err, Error::Unquotable(m) if m == "gone.py is not in the review"));
}

#[tokio::test]
async fn checks_a_payloads_own_quoted_range_against_the_snapshot_before_keeping_it() {
    let dir = tempfile::tempdir().unwrap();
    let s = CommentStore::open(dir.path(), "working").await.unwrap();
    let outside = json!({ "path": "../../etc/passwd", "startLine": 1, "body": "x", "quoted": "root:x:0:0" });
    assert!(matches!(s.import_threads(imports(outside), &Fixed).await, Err(Error::Unquotable(_))));
    let shown = json!({ "path": "a.py", "startLine": 1, "body": "x", "quoted": "as shown" });
    let (added, _) = s.import_threads(imports(shown), &Fixed).await.unwrap();
    assert!(matches!(&added[0].anchor, CommentAnchor::Line { quoted, .. } if quoted == "as shown"));
}

#[tokio::test]
async fn keeps_the_newest_previous_viewed_mark_per_path_and_caps_the_history() {
    let dir = tempfile::tempdir().unwrap();
    let s = CommentStore::open(dir.path(), "working").await.unwrap();
    s.set_viewed("a.py", "sha1", true).await.unwrap();
    s.set_viewed("a.py", "sha1", false).await.unwrap();
    assert_eq!(marks(s.viewed().await.unwrap()), [mark("a.py", "sha1", false)]);
    s.set_viewed("a.py", "sha2", true).await.unwrap();
    s.set_viewed("a.py", "sha3", true).await.unwrap();
    assert_eq!(marks(s.viewed().await.unwrap()), [mark("a.py", "sha2", true), mark("a.py", "sha3", true)]);
    s.set_viewed_many(vec![entry("a.py", "sha4", false)]).await.unwrap();
    assert_eq!(marks(s.viewed().await.unwrap()), [mark("a.py", "sha4", false)]);
}

#[tokio::test]
async fn relocates_flags_stale_and_unflags_when_text_returns() {
    let dir = tempfile::tempdir().unwrap();
    let s = CommentStore::open(dir.path(), "working").await.unwrap();
    let t = s.add_thread(anchor(), "hello".into()).await.unwrap();
    s.reply(&t.id, "follows the anchor".into()).await.unwrap();
    let get = || async { s.get(&t.id).await.unwrap().unwrap() };
    assert!(s.relocate_all(&Whole("z\na\nb\n", None)).await.unwrap());
    assert_eq!(start(&get().await), 3);
    assert!(s.relocate_all(&Whole("nothing here\n", None)).await.unwrap());
    let stale = get().await;
    assert!(stale.stale);
    assert_eq!(stale.stale_from_line, Some(3));
    assert!(s.relocate_all(&Whole("b\n", None)).await.unwrap());
    let back = get().await;
    assert!(!back.stale && back.stale_from_line.is_none());
    assert_eq!(start(&back), 1);
    assert!(!s.relocate_all(&Whole("b\n", None)).await.unwrap());
}

#[tokio::test]
async fn flags_a_thread_stale_when_its_text_leaves_the_shown_ranges_and_clears_it_when_they_return() {
    let dir = tempfile::tempdir().unwrap();
    let s = CommentStore::open(dir.path(), "working").await.unwrap();
    let t = s.add_thread(anchor(), "hello".into()).await.unwrap();
    let contents = "a\nb\nc\nd\ne\n";
    let get = || async { s.get(&t.id).await.unwrap().unwrap() };
    assert!(s.relocate_all(&Whole(contents, Some(vec![(4, 5)]))).await.unwrap());
    assert!(get().await.stale);
    assert_eq!(start(&get().await), 2);
    assert!(s.relocate_all(&Whole(contents, Some(vec![(1, 3)]))).await.unwrap());
    assert!(!get().await.stale);
    assert!(s.relocate_all(&Whole(contents, Some(vec![]))).await.unwrap());
    assert!(get().await.stale);
}

#[tokio::test]
async fn a_file_thread_is_stale_while_its_file_is_out_of_the_review() {
    let dir = tempfile::tempdir().unwrap();
    let s = CommentStore::open(dir.path(), "working").await.unwrap();
    let t = s.add_thread(file_anchor(), "hello".into()).await.unwrap();
    let get = || async { s.get(&t.id).await.unwrap().unwrap() };
    assert!(!s.relocate_all(&Files(true)).await.unwrap());
    assert!(!get().await.stale);
    assert!(s.relocate_all(&Files(false)).await.unwrap());
    let stale = get().await;
    assert!(stale.stale && stale.stale_from_line.is_none());
    assert!(matches!(stale.anchor, CommentAnchor::File { .. }));
    assert!(s.relocate_all(&Files(true)).await.unwrap());
    assert!(!get().await.stale);
}

#[tokio::test]
async fn removes_stale_threads_only() {
    let dir = tempfile::tempdir().unwrap();
    let s = CommentStore::open(dir.path(), "working").await.unwrap();
    let missing = CommentAnchor::Line {
        path: "a.py".into(),
        side: Side::New,
        start_line: 2,
        end_line: 2,
        quoted: "missing".into(),
    };
    let gone = s.add_thread(missing, "hello".into()).await.unwrap();
    let kept = s.add_thread(anchor(), "hello".into()).await.unwrap();
    s.relocate_all(&Whole("a\nb\n", None)).await.unwrap();
    assert!(s.get(&gone.id).await.unwrap().unwrap().stale);
    assert_eq!(s.remove_stale().await.unwrap(), 1);
    assert_eq!(s.remove_stale().await.unwrap(), 0);
    assert_eq!(s.threads(&all()).await.unwrap().iter().map(|t| t.id.clone()).collect::<Vec<_>>(), [kept.id]);
}

#[tokio::test]
async fn two_stores_on_one_file_keep_each_others_sets_and_writes() {
    let dir = tempfile::tempdir().unwrap();
    let working = CommentStore::open(dir.path(), "working").await.unwrap();
    let pr = CommentStore::open(dir.path(), "pr:abc").await.unwrap();
    let twin = CommentStore::open(dir.path(), "working").await.unwrap();
    let t = working.add_thread(anchor(), "w".into()).await.unwrap();
    pr.add_thread(anchor(), "p".into()).await.unwrap();
    working.set_viewed("a.py", "sha", true).await.unwrap();
    let raw = raw(dir.path());
    assert_eq!(raw["sets"]["working"]["threads"][0]["messages"][0]["body"], "w");
    assert_eq!(raw["sets"]["pr:abc"]["threads"][0]["messages"][0]["body"], "p");
    // The twin never loaded t, yet serves it and must not drop it on its own write.
    twin.reply(&t.id, "from twin".into()).await.unwrap();
    let bodies: Vec<String> = working.get(&t.id).await.unwrap().unwrap().messages.into_iter().map(|m| m.body).collect();
    assert_eq!(bodies, ["w", "from twin"]);
    assert_eq!(marks(twin.viewed().await.unwrap()), [mark("a.py", "sha", true)]);
}

#[tokio::test]
async fn concurrent_writes_from_several_stores_and_keys_all_survive_reload() {
    let dir = tempfile::tempdir().unwrap();
    let old = CommentStore::open(dir.path(), "working").await.unwrap();
    let next = CommentStore::open(dir.path(), "pr:abc").await.unwrap();
    let other = CommentStore::open(dir.path(), "working").await.unwrap();
    let (a, b, c, d, e, f) = tokio::join!(
        old.set_viewed("a.py", "sha", true),
        next.add_thread(anchor(), "n1".into()),
        old.add_thread(anchor(), "o1".into()),
        next.set_viewed("b.py", "sha", true),
        other.add_thread(anchor(), "o2".into()),
        next.add_thread(anchor(), "n2".into()),
    );
    a.unwrap();
    b.unwrap();
    c.unwrap();
    d.unwrap();
    e.unwrap();
    f.unwrap();
    let bodies = |key: &'static str| {
        let dir = dir.path().to_owned();
        async move {
            let store = CommentStore::open(&dir, key).await.unwrap();
            let mut b: Vec<String> =
                store.threads(&all()).await.unwrap().iter().map(|t| first_body(t).to_owned()).collect();
            b.sort();
            (b, marks(store.viewed().await.unwrap()))
        }
    };
    assert_eq!(bodies("working").await, (vec!["o1".to_owned(), "o2".into()], vec![mark("a.py", "sha", true)]));
    assert_eq!(bodies("pr:abc").await, (vec!["n1".to_owned(), "n2".into()], vec![mark("b.py", "sha", true)]));
    // Unique temp names: nothing left beside the file but its lock.
    let mut left: Vec<String> = std::fs::read_dir(dir.path().join("diffle"))
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    left.sort();
    assert_eq!(left, ["comments.json", "comments.json.lock"]);
}

#[tokio::test]
async fn a_deletion_by_one_store_is_not_resurrected_by_another() {
    let dir = tempfile::tempdir().unwrap();
    let a = CommentStore::open(dir.path(), "working").await.unwrap();
    let b = CommentStore::open(dir.path(), "working").await.unwrap();
    let t = a.add_thread(anchor(), "hello".into()).await.unwrap();
    assert!(b.get(&t.id).await.unwrap().is_some());
    a.remove_thread(&t.id).await.unwrap();
    b.set_viewed("a.py", "sha", true).await.unwrap();
    assert!(matches!(b.reply(&t.id, "late".into()).await, Err(Error::NotFound(_))));
    assert!(a.threads(&all()).await.unwrap().is_empty());
}

#[tokio::test]
async fn a_failed_write_is_not_acknowledged_and_does_not_block_the_next_one() {
    let dir = tempfile::tempdir().unwrap();
    let s = CommentStore::open(dir.path(), "working").await.unwrap();
    // A directory where the file belongs makes the read-modify-write fail.
    std::fs::create_dir_all(s.file()).unwrap();
    assert!(s.add_thread(anchor(), "first".into()).await.is_err());
    std::fs::remove_dir(s.file()).unwrap();
    s.add_thread(anchor(), "second".into()).await.unwrap();
    assert_eq!(raw(dir.path())["sets"]["working"]["threads"][0]["messages"][0]["body"], "second");
    assert_eq!(raw(dir.path())["sets"]["working"]["threads"].as_array().unwrap().len(), 1);
}

/// Store futures are awaited inside spawned tasks and HTTP handlers.
#[tokio::test]
async fn store_futures_are_send() {
    fn send<T: Send>(_: T) {}
    let s = CommentStore::open(Path::new("."), "k").await.unwrap();
    send(s.relocate_all(&Whole("", None)));
    send(s.import_threads(Vec::new(), &Quotes));
    send(s.add_thread(anchor(), String::new()));
}
