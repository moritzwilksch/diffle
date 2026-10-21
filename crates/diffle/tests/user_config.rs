use std::collections::HashMap;
use std::sync::Arc;

use diffle::protocol::{FollowRefs, LanguageId};
use diffle::user_config::{UserConfigPatch, UserConfigStore};
use serde_json::{Value, json};

fn temp() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

async fn open_with(dir: &tempfile::TempDir, content: Value) -> UserConfigStore {
    let file = dir.path().join("config.json");
    std::fs::write(&file, content.to_string()).unwrap();
    UserConfigStore::open(file).await
}

fn on_disk(store: &UserConfigStore) -> Value {
    serde_json::from_str(&std::fs::read_to_string(store.file()).unwrap()).unwrap()
}

#[tokio::test]
async fn serializes_overlapping_writes_and_leaves_no_temp_files() {
    let dir = temp();
    let store = Arc::new(open_with(&dir, json!({ "lspCommands": { "python": "x" } })).await);
    let set = |patch: UserConfigPatch| {
        let store = store.clone();
        async move { store.set(patch).await.unwrap().context_lines }
    };
    let python = HashMap::from([(LanguageId::Python, "x".to_owned())]);
    let results = futures::join!(
        set(UserConfigPatch { context_lines: Some(1), ..Default::default() }),
        set(UserConfigPatch { line_wrap: Some(false), ..Default::default() }),
        set(UserConfigPatch { context_lines: Some(9), ..Default::default() }),
    );
    assert_eq!(results, (1, 1, 9));
    assert_eq!((store.get().context_lines, store.get().lsp_commands), (9, python.clone()));
    let disk = on_disk(&store);
    assert_eq!((disk["contextLines"].clone(), disk["lspCommands"].clone()), (json!(9), json!({ "python": "x" })));
    let left: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(left, ["config.json"]);
    let reopened = UserConfigStore::open(store.file().to_owned()).await.get();
    assert_eq!((reopened.context_lines, reopened.lsp_commands), (9, python));
}

#[tokio::test]
async fn reads_follow_refs_as_on_auto_or_off_and_falls_back_to_auto_otherwise() {
    let dir = temp();
    for stale in [json!("yes"), json!(true), json!(false)] {
        assert_eq!(open_with(&dir, json!({ "followRefs": stale })).await.get().follow_refs, FollowRefs::Auto);
    }
    assert_eq!(open_with(&dir, json!({ "followRefs": "on" })).await.get().follow_refs, FollowRefs::On);
}

#[tokio::test]
async fn wraps_lines_by_default_and_keeps_an_explicit_choice_across_reopening() {
    let dir = temp();
    let store = open_with(&dir, json!({ "lineWrap": "no" })).await;
    assert!(store.get().line_wrap);
    store.set(UserConfigPatch { line_wrap: Some(false), ..Default::default() }).await.unwrap();
    assert!(!UserConfigStore::open(store.file().to_owned()).await.get().line_wrap);
}

#[tokio::test]
async fn keeps_known_languages_and_drops_the_rest_including_fields_it_does_not_read() {
    let dir = temp();
    let store =
        open_with(&dir, json!({ "lspCommand": "x", "lspCommands": { "go": " gopls ", "rust": "", "nope": "x" } }))
            .await;
    let expected = HashMap::from([(LanguageId::Go, "gopls".to_owned()), (LanguageId::Rust, String::new())]);
    assert_eq!(store.get().lsp_commands, expected);
    store.set(UserConfigPatch { context_lines: Some(3), ..Default::default() }).await.unwrap();
    assert!(on_disk(&store).get("lspCommand").is_none());
}

#[tokio::test]
async fn lowercases_github_hosts_and_drops_an_entry_with_no_web_host() {
    let dir = temp();
    let hosts = json!({ " SSH.Work.com ": "GitHub.work.com", "a.com": " ", "b": 3 });
    let store = open_with(&dir, json!({ "githubHosts": hosts })).await;
    assert_eq!(store.get().github_hosts, HashMap::from([("ssh.work.com".to_owned(), "github.work.com".to_owned())]));
    assert!(open_with(&dir, json!({ "githubHosts": "github.work.com" })).await.get().github_hosts.is_empty());
}

#[tokio::test]
async fn clamps_context_lines_and_trims_auto_viewed_globs() {
    let dir = temp();
    let store = open_with(&dir, json!({ "contextLines": 12345.7, "autoViewed": [" *.lock ", "", 3, "dist/**"] })).await;
    assert_eq!(store.get().context_lines, 10_000);
    assert_eq!(store.get().auto_viewed, ["*.lock", "dist/**"]);
    assert_eq!(open_with(&dir, json!({ "contextLines": -2.5 })).await.get().context_lines, 0);
    assert_eq!(open_with(&dir, json!("not an object")).await.get().context_lines, 5);
    std::fs::write(dir.path().join("config.json"), "{ broken").unwrap();
    assert_eq!(UserConfigStore::open(dir.path().join("config.json")).await.get().context_lines, 5);
}
