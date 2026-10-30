//! The LSP routes over the real language servers pixi's default environment puts on PATH: the
//! catalog's command lines and configuration, and the wire shapes each server answers in.
//!
//! A test skips when its server is not on PATH, so a plain `cargo test` passes; `pixi run test-rust`
//! sets `DIFFLE_REQUIRE_LSPS`, which turns a missing server into a failure. Answers are asserted
//! where they hold across releases: locations and names exactly, hover text by what it contains.
// Windows next: there the servers are `.cmd` shims, a spawn path worth its own round.
#![cfg(unix)]
mod common;

use std::time::{Duration, Instant};

use serde_json::{Value, json};

use common::TestRepo;
use common::server::TestServer;
use diffle::lsp::which::find_on_path;
use diffle::protocol::EnterRequest;

/// Whether `program` is on PATH; a missing one fails the test under `DIFFLE_REQUIRE_LSPS`.
fn on_path(program: &str) -> bool {
    if find_on_path(program).is_some() {
        return true;
    }
    assert!(std::env::var_os("DIFFLE_REQUIRE_LSPS").is_none(), "{program} is not on PATH");
    eprintln!("{program} is not on PATH; skipping");
    false
}

/// `files` committed, then each of `edits` written to the worktree, which is what is reviewed.
async fn serve(files: &[(&str, &str)], edits: &[(&str, &str)]) -> TestServer {
    let t = TestRepo::new();
    for (path, content) in files {
        t.write(path, content);
    }
    t.commit("base");
    for (path, content) in edits {
        t.write(path, content);
    }
    TestServer::with_path_lsp(t, EnterRequest::Working).await
}

/// The servers' logs, for a failure to explain itself.
async fn logs(s: &TestServer) -> String {
    let mut out = String::new();
    for name in server_names(s) {
        let log = s.get(&format!("/api/lsp/log?server={name}")).await.json();
        for entry in log["entries"].as_array().into_iter().flatten() {
            out.push_str(&format!("{name}: {}\n", entry["message"].as_str().unwrap_or_default()));
        }
    }
    out
}

/// Asks `route` until `expected` holds of its answer. A server answers 409 while it starts or
/// indexes, and tsserver answers from a half-loaded project at first (an import, not what it
/// imports), so a first answer is not the final one.
async fn until<T: PartialEq + std::fmt::Debug>(
    s: &TestServer,
    route: &str,
    body: Value,
    read: impl Fn(&Value) -> T,
    expected: T,
) {
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        let r = s.json("POST", &format!("/api/lsp/{route}"), body.clone()).await;
        if r.status == 200 && read(&r.json()) == expected {
            return;
        }
        if Instant::now() > deadline {
            panic!("{route} {body}: expected {expected:?}, last answered {} {}\n{}", r.status, r.body, logs(s).await);
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// The locations' paths and lines, the part of an answer servers agree on.
fn places(answer: &Value) -> Vec<(String, u64)> {
    let locations = answer["locations"].as_array().into_iter().flatten();
    let mut places: Vec<_> =
        locations.map(|l| (l["path"].as_str().unwrap().to_owned(), l["line"].as_u64().unwrap())).collect();
    places.sort();
    places
}

async fn places_until(s: &TestServer, route: &str, body: Value, expected: &[(&str, u64)]) {
    let expected = expected.iter().map(|(p, l)| ((*p).to_owned(), *l)).collect();
    until(s, route, body, places, expected).await;
}

/// Waits for a hover whose text holds every one of `needles`: releases reword the rest.
async fn hover_until(s: &TestServer, body: Value, needles: &[&str]) {
    let holds = |answer: &Value| {
        let text = answer["contents"].as_str().unwrap_or_default();
        needles.iter().all(|n| text.contains(n))
    };
    until(s, "hover", body, holds, true).await;
}

async fn symbols(s: &TestServer, path: &str) -> Vec<String> {
    let doc = s.get(&format!("/api/lsp/symbols?path={path}")).await;
    assert_eq!(doc.status, 200, "{}", doc.body);
    doc.json()["symbols"].as_array().unwrap().iter().map(|x| x["name"].as_str().unwrap().to_owned()).collect()
}

fn server_names(s: &TestServer) -> Vec<String> {
    s.lsp.as_ref().unwrap().status().servers.into_iter().map(|x| x.name).collect()
}

const LIB_PY: &str = "def greet(name: str) -> str:\n    \"\"\"Says hello.\"\"\"\n    return f\"hello {name}\"\n";
const MAIN_PY: &str = "from lib import greet\n\nprint(greet(\"ada\"))\n";

#[tokio::test]
async fn pyrefly_answers_definition_hover_references_and_symbols() {
    if !on_path("pyrefly") {
        return;
    }
    let s = serve(&[("lib.py", LIB_PY), ("main.py", MAIN_PY)], &[("main.py", &MAIN_PY.replace("ada", "grace"))]).await;
    let call = json!({ "path": "main.py", "line": 3, "col": 6 });
    places_until(&s, "definition", call.clone(), &[("lib.py", 1)]).await;
    hover_until(&s, call, &["def greet(name: str) -> str", "Says hello."]).await;
    let def = json!({ "path": "lib.py", "line": 1, "col": 4 });
    places_until(&s, "references", def, &[("lib.py", 1), ("main.py", 1), ("main.py", 3)]).await;
    assert_eq!(symbols(&s, "lib.py").await, ["greet"]);
    assert_eq!(server_names(&s), ["pyrefly"]);
    s.close().await;
}

const MATH_TS: &str =
    "/** Adds two numbers. */\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n";
const MAIN_TS: &str = "import { add } from './math';\n\nconsole.log(add(1, 2));\n";

/// typescript-language-server, reading the TypeScript beside it in the environment (the tsdk).
#[tokio::test]
async fn typescript_language_server_answers_definition_hover_references_and_symbols() {
    if !on_path("typescript-language-server") {
        return;
    }
    let s = serve(&[("math.ts", MATH_TS), ("main.ts", MAIN_TS)], &[("main.ts", &MAIN_TS.replace("2", "3"))]).await;
    let call = json!({ "path": "main.ts", "line": 3, "col": 12 });
    places_until(&s, "definition", call.clone(), &[("math.ts", 2)]).await;
    hover_until(&s, call, &["add(a: number, b: number): number", "Adds two numbers."]).await;
    let def = json!({ "path": "math.ts", "line": 2, "col": 16 });
    places_until(&s, "references", def, &[("main.ts", 1), ("main.ts", 3), ("math.ts", 2)]).await;
    assert_eq!(symbols(&s, "math.ts").await, ["add"]);
    // Tailwind joins every TypeScript file, as an editor extension would.
    assert_eq!(server_names(&s), ["typescript-language-server", "tailwindcss-language-server"]);
    s.close().await;
}

const APP_VUE: &str = "<script setup lang=\"ts\">\nimport { add } from './math';\nconst total = add(1, 2);\n</script>\n\n<template>\n  <p>{{ total }}</p>\n</template>\n";

/// A `.vue` file answers through tsserver, with the plugin vue-language-server ships loaded into it.
#[tokio::test]
async fn vue_files_answer_through_tsserver_and_the_vue_plugin() {
    if !on_path("typescript-language-server") || !on_path("vue-language-server") {
        return;
    }
    let s = serve(&[("math.ts", MATH_TS), ("App.vue", APP_VUE)], &[("App.vue", &APP_VUE.replace("2", "3"))]).await;
    let call = json!({ "path": "App.vue", "line": 3, "col": 14 });
    places_until(&s, "definition", call.clone(), &[("math.ts", 2)]).await;
    hover_until(&s, call, &["add(a: number, b: number): number"]).await;
    s.close().await;
}

const CARGO_TOML: &str = "[package]\nname = \"demo\"\nversion = \"0.1.0\"\nedition = \"2024\"\n";
const MAIN_RS: &str = "mod shapes;\n\nfn main() {\n    println!(\"{}\", shapes::area(2, 3));\n}\n";
const SHAPES_RS: &str = "/// The area of a `w` by `h` rectangle.\npub fn area(w: u32, h: u32) -> u32 {\n    w * h\n}\n";

/// rust-analyzer, given the crate's manifest as a linked project.
#[tokio::test]
async fn rust_analyzer_answers_definition_hover_references_and_symbols() {
    if !on_path("rust-analyzer") || !on_path("cargo") {
        return;
    }
    let files = [("Cargo.toml", CARGO_TOML), ("src/main.rs", MAIN_RS), ("src/shapes.rs", SHAPES_RS)];
    let s = serve(&files, &[("src/main.rs", &MAIN_RS.replace("(2, 3)", "(4, 5)"))]).await;
    let call = json!({ "path": "src/main.rs", "line": 4, "col": 28 });
    places_until(&s, "definition", call.clone(), &[("src/shapes.rs", 2)]).await;
    hover_until(&s, call, &["pub fn area(w: u32, h: u32) -> u32", "rectangle"]).await;
    let def = json!({ "path": "src/shapes.rs", "line": 2, "col": 7 });
    places_until(&s, "references", def, &[("src/main.rs", 4), ("src/shapes.rs", 2)]).await;
    assert_eq!(symbols(&s, "src/shapes.rs").await, ["area"]);
    assert_eq!(server_names(&s), ["rust-analyzer"]);
    s.close().await;
}

const MAIN_C: &str = "static int twice(int x) { return 2 * x; }\n\nint main(void) {\n  return twice(1);\n}\n";

/// clangd, with no compilation database: its fallback flags still resolve one file.
#[tokio::test]
async fn clangd_answers_definition_hover_and_symbols() {
    if !on_path("clangd") {
        return;
    }
    let s = serve(&[("main.c", MAIN_C)], &[("main.c", &MAIN_C.replace("twice(1)", "twice(2)"))]).await;
    let call = json!({ "path": "main.c", "line": 4, "col": 10 });
    places_until(&s, "definition", call.clone(), &[("main.c", 1)]).await;
    hover_until(&s, call, &["twice", "int x"]).await;
    assert_eq!(symbols(&s, "main.c").await, ["twice", "main"]);
    assert_eq!(server_names(&s), ["clangd"]);
    s.close().await;
}

const DEPLOY_SH: &str = "#!/bin/sh\ngreet() {\n  echo \"hello $1\"\n}\n\ngreet ada\n";

#[tokio::test]
async fn bash_language_server_answers_definition_and_symbols() {
    if !on_path("bash-language-server") {
        return;
    }
    let s = serve(&[("deploy.sh", DEPLOY_SH)], &[("deploy.sh", &DEPLOY_SH.replace("ada", "grace"))]).await;
    places_until(&s, "definition", json!({ "path": "deploy.sh", "line": 6, "col": 0 }), &[("deploy.sh", 2)]).await;
    assert_eq!(symbols(&s, "deploy.sh").await, ["greet"]);
    assert_eq!(server_names(&s), ["bash-language-server"]);
    s.close().await;
}
