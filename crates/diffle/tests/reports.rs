mod common;

use std::path::PathBuf;
use std::time::{Duration, Instant};

use common::TestRepo;
use common::server::TestServer;
use diffle::protocol::EnterRequest;
use diffle::reports::catalog::{Plugin, Scope};
use futures::StreamExt;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

const PNG: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/// `a.txt` and `keep.md` committed; the worktree edits `a.txt` and adds `b.txt`.
fn repo() -> TestRepo {
    let t = TestRepo::new();
    t.write("a.txt", "a\n");
    t.write("keep.md", "kept\n");
    t.commit("base");
    t.write("a.txt", "a\nb\n");
    t.write("b.txt", "bee\n");
    t
}

async fn reports(s: &TestServer) -> Value {
    let r = s.get("/api/reports").await;
    assert_eq!(r.status, 200, "{}", r.body);
    r.json()
}

fn report<'a>(list: &'a Value, id: &str) -> Option<&'a Value> {
    list["reports"].as_array().unwrap().iter().find(|r| r["id"] == id)
}

/// The report `id` once its run ended, or none once it left the list.
async fn settled(s: &TestServer, id: &str) -> Option<Value> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let list = reports(s).await;
        match report(&list, id) {
            Some(r) if r["status"] != "running" => return Some(r.clone()),
            None => return None,
            Some(_) => {}
        }
        assert!(Instant::now() < deadline, "report {id} never settled: {list}");
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

#[tokio::test]
async fn pushes_lists_and_persists_a_report() {
    let s = TestServer::over(repo(), EnterRequest::Working).await;
    let mut ws = tokio_tungstenite::connect_async(s.ws_url().into_client_request().unwrap()).await.unwrap().0;
    let body = json!({
        "title": " Notes ",
        "blocks": [
            { "kind": "markdown", "text": "\n# Risky\n\nLook at b", "anchor": { "path": "a.txt", "line": 2 } },
            { "kind": "markdown", "text": "gone", "anchor": { "path": "nope.txt", "line": 1 } }
        ]
    });
    let r = s.json("PUT", "/api/reports/notes", body.clone()).await;
    assert_eq!(r.status, 201, "{}", r.body);
    let created = r.json();
    assert_eq!((created["title"].as_str(), created["summary"].as_str()), (Some("Notes"), Some("Risky")));
    assert_eq!((created["source"].as_str(), created["stale"].as_bool()), (Some("pushed"), Some(false)));
    assert_eq!(created["blocks"][0]["anchor"], json!({ "path": "a.txt", "line": 2 }));
    assert!(created["blocks"][1].get("anchor").is_none(), "{}", created["blocks"][1]);
    let pushed = tokio::time::timeout(Duration::from_secs(5), ws.next()).await.unwrap().unwrap().unwrap();
    assert_eq!(pushed.into_text().unwrap().as_str(), r#"{"type":"reports"}"#);

    let list = reports(&s).await;
    assert_eq!(list["current"]["newSha"], "worktree");
    assert_eq!(report(&list, "notes").unwrap()["target"], list["current"]);
    let log = s.get("/api/reports/notes/log").await.json();
    assert!(log["lines"][0].as_str().unwrap().contains("blocks[1].anchor dropped"), "{log}");
    assert_eq!(s.json("PUT", "/api/reports/notes", body).await.status, 200);

    // The report outlives the server: the next one over the repository lists it, unstale while
    // the worktree stands, stale once it moves.
    let repo = s.stop().await;
    let s = TestServer::over(repo, EnterRequest::Working).await;
    let list = reports(&s).await;
    assert_eq!(report(&list, "notes").unwrap()["stale"], false, "{list}");
    s.repo.write("a.txt", "a\nb\nc\n");
    s.session.refresh().await;
    let list = reports(&s).await;
    assert_eq!(report(&list, "notes").unwrap()["stale"], true, "{list}");
    assert_ne!(report(&list, "notes").unwrap()["target"]["digest"], list["current"]["digest"]);

    assert_eq!(s.send("DELETE", "/api/reports/notes", &[], None).await.status, 204);
    assert_eq!(s.get("/api/reports/notes").await.status, 404);
    assert_eq!(s.send("DELETE", "/api/reports/notes", &[], None).await.status, 404);
    s.close().await;
}

#[tokio::test]
async fn serves_uploaded_pages_by_key() {
    let s = TestServer::over(repo(), EnterRequest::Working).await;
    let png = [&PNG[..], b"one"].concat();
    let r = s.client_put_bytes("/api/reports/render/files/p/1.png", png.clone()).await;
    assert_eq!(r.0, 201, "{}", r.1);
    let file: Value = serde_json::from_str(&r.1).unwrap();
    let key = file["key"].as_str().unwrap().to_owned();
    assert_eq!(file["type"], "image/png");
    let bad = s.client_put_bytes("/api/reports/render/files/bad.bin", vec![0, 1, 2, 3]).await;
    assert_eq!(bad.0, 400, "{}", bad.1);
    let bad = s.client_put_bytes("/api/reports/render/files/../x.png", png.clone()).await;
    assert!(bad.0 == 400 || bad.0 == 404, "{} {}", bad.0, bad.1);

    let pages = |file: &str| json!({ "title": "Rendered", "blocks": [{ "kind": "pages", "label": "Pages", "pages": [{ "label": "p. 1", "old": null, "new": file }] }] });
    let r = s.json("PUT", "/api/reports/render", pages("missing.png")).await;
    assert_eq!(r.status, 400, "{}", r.body);
    assert!(r.body.contains("no file uploaded"), "{}", r.body);
    let r = s.json("PUT", "/api/reports/render", pages("p/1.png")).await;
    assert_eq!(r.status, 201, "{}", r.body);
    assert_eq!(r.json()["blocks"][0]["pages"][0]["new"]["key"], key);

    let res = s.fetch(&format!("/api/reports/render/file?key={key}")).await;
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["content-type"], "image/png");
    assert!(res.headers()["cache-control"].to_str().unwrap().contains("immutable"));
    assert_eq!(res.bytes().await.unwrap().to_vec(), png);
    assert_eq!(s.fetch("/api/reports/render/file?key=0000000000000000000000000000000000000000").await.status(), 404);
    assert_eq!(s.fetch(&format!("/api/reports/other/file?key={key}")).await.status(), 404);
    s.close().await;
}

#[tokio::test]
async fn refuses_bad_ids_and_stale_targets() {
    let s = TestServer::over(repo(), EnterRequest::Working).await;
    let notes =
        |target: Value| json!({ "title": "Notes", "target": target, "blocks": [{ "kind": "markdown", "text": "hi" }] });
    let r = s.json("PUT", "/api/reports/Bad_Id", notes(Value::Null)).await;
    assert_eq!(r.status, 400, "{}", r.body);
    let r = s.json("PUT", "/api/reports/notes", notes(json!({ "oldSha": "x", "newSha": "y", "digest": "z" }))).await;
    assert_eq!(r.status, 409, "{}", r.body);
    let current = reports(&s).await["current"].clone();
    assert_eq!(r.json()["current"], current);
    let r = s.json("PUT", "/api/reports/notes", notes(current)).await;
    assert_eq!(r.status, 201, "{}", r.body);
    let r = s.json("PUT", "/api/reports/notes", json!({ "title": "", "blocks": [] })).await;
    assert_eq!(r.status, 400, "{}", r.body);
    s.close().await;
}

/// The generator tests spawn `node` with a POSIX path in the command line; a Windows path's
/// backslashes would need quoting the tests do not exercise.
#[cfg(unix)]
mod generators {
    use super::*;

    fn fake(name: &str, args: &str, when: &[&str], scope: Scope) -> Plugin {
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/reports/fake-generator.mjs");
        let script = dunce::canonicalize(script).unwrap();
        Plugin {
            name: name.into(),
            command: format!("node '{}' {args}", script.display()),
            when: when.iter().map(|w| (*w).to_owned()).collect(),
            scope,
            configured: true,
        }
    }

    fn node() -> bool {
        let found = diffle::lsp::which::find_on_path("node").is_some();
        if !found {
            eprintln!("node is not on PATH; skipping the generator tests");
        }
        found
    }

    #[tokio::test]
    async fn runs_generators_for_matching_files() {
        if !node() {
            return;
        }
        let plugins = vec![
            fake("fake", "json", &["*.txt"], Scope::Changed),
            fake("each", "stdout $DIFFLE_FILE", &["*.txt"], Scope::Changed),
            fake("tree", "json", &["b.txt"], Scope::Tree),
            fake("broken", "fail", &["a.txt"], Scope::Changed),
            fake("quiet", "json", &["*.rs"], Scope::Changed),
            Plugin {
                name: "missing".into(),
                command: "no-such-program-xyz".into(),
                when: vec!["a.txt".into()],
                scope: Scope::Changed,
                configured: true,
            },
        ];
        let s = TestServer::with_plugins(repo(), EnterRequest::Working, plugins).await;

        let fake = settled(&s, "fake").await.unwrap();
        assert_eq!(
            (fake["status"].as_str(), fake["title"].as_str(), fake["source"].as_str()),
            (Some("ready"), Some("Fake report"), Some("generator"))
        );
        let text = fake["blocks"][0]["text"].as_str().unwrap();
        assert!(text.contains("old: a.txt\nnew: a.txt, b.txt\nscope: changed\nfiles: a.txt, b.txt"), "{text}");
        assert!(text.contains("a.txt=a\nb"), "{text}");
        assert_eq!(fake["blocks"][0]["anchor"], json!({ "path": "a.txt", "line": 1 }));
        let key = fake["blocks"][1]["pages"][0]["new"]["key"].as_str().unwrap();
        assert_eq!(s.fetch(&format!("/api/reports/fake/file?key={key}")).await.status(), 200);
        assert_eq!(s.get("/api/reports/fake/log").await.json()["lines"], json!(["rendered 1 page"]));

        let each = settled(&s, "each").await.unwrap();
        let texts: Vec<&str> = each["blocks"].as_array().unwrap().iter().map(|b| b["text"].as_str().unwrap()).collect();
        assert_eq!(
            texts,
            ["### a.txt\n\na.txt: old=a.txt new=a.txt,b.txt", "### b.txt\n\nb.txt: old=a.txt new=a.txt,b.txt"]
        );
        assert_eq!(each["blocks"][1]["anchor"], json!({ "path": "b.txt", "side": "new", "line": 1 }));
        assert_eq!(each["summary"], "a.txt");

        let tree = settled(&s, "tree").await.unwrap();
        let text = tree["blocks"][0]["text"].as_str().unwrap();
        assert!(text.contains("old: a.txt, keep.md\nnew: a.txt, b.txt, keep.md\nscope: tree\nfiles: b.txt"), "{text}");

        let broken = settled(&s, "broken").await.unwrap();
        assert_eq!(broken["status"], "failed");
        assert_eq!(broken["error"], "node exited 3: boom: no such thing");
        assert_eq!(s.get("/api/reports/broken/log").await.json()["lines"], json!(["boom: no such thing"]));
        let missing = settled(&s, "missing").await.unwrap();
        assert_eq!(missing["error"], "no-such-program-xyz: not on PATH");
        assert!(settled(&s, "quiet").await.is_none());

        // A generator's id is its own.
        let r = s.json("PUT", "/api/reports/fake", json!({ "title": "x", "blocks": [] })).await;
        assert_eq!(r.status, 409, "{}", r.body);
        assert_eq!(s.send("DELETE", "/api/reports/fake", &[], None).await.status, 409);

        // The worktree moves: the report follows it, then leaves with the last matching file.
        s.repo.write("a.txt", "a\nb\nc\n");
        s.session.refresh().await;
        let fake = settled(&s, "fake").await.unwrap();
        assert!(fake["blocks"][0]["text"].as_str().unwrap().contains("a.txt=a\nb\nc"), "{fake}");
        assert_eq!(fake["stale"], false);
        s.repo.write("a.txt", "a\n");
        s.repo.rm("b.txt");
        s.session.refresh().await;
        assert!(settled(&s, "fake").await.is_none());
        assert!(settled(&s, "each").await.is_none());
        s.close().await;
    }
}
