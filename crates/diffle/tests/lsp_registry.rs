//! Which language servers a diff gets, and how each is configured.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use diffle::lsp::registry::{Lookup, ResolvedServer, ServerContext, candidates_for, definition_of, resolve_servers};
use diffle::protocol::LanguageId::{self, *};
use diffle::protocol::{LspMissing, language_ids};
use serde_json::{Value, json};

/// A PATH holding exactly `programs`.
fn path(programs: &[&str]) -> Lookup {
    let programs: Vec<String> = programs.iter().map(|p| (*p).to_owned()).collect();
    Arc::new(move |command: &str| {
        let program = command.split(' ').next().unwrap_or_default();
        programs.iter().any(|p| p == program).then(|| PathBuf::from(format!("/usr/bin/{program}")))
    })
}

fn server(command: &str, languages: &[LanguageId], joins: &[LanguageId]) -> ResolvedServer {
    ResolvedServer { command: command.into(), languages: languages.to_vec(), joins: joins.to_vec() }
}

fn missing(m: &[LspMissing]) -> Value {
    serde_json::to_value(m).unwrap()
}

fn none() -> HashMap<LanguageId, String> {
    HashMap::new()
}

#[test]
fn takes_the_first_candidate_on_path_and_names_the_rest_as_missing() {
    let r = resolve_servers([Python, Go], &none(), &path(&["pylsp", "jedi-language-server"]));
    assert_eq!(r.servers, [server("pylsp", &[Python], &[])]);
    assert_eq!(missing(&r.missing), json!([{ "language": "go", "tried": ["gopls"] }]));
}

#[test]
fn groups_languages_that_share_a_command_into_one_server() {
    let r = resolve_servers([Cpp, C, Typescript, Javascript], &none(), &path(&["clangd", "vtsls"]));
    assert_eq!(r.servers, [server("clangd", &[C, Cpp], &[]), server("vtsls --stdio", &[Javascript, Typescript], &[])]);
}

#[test]
fn sorts_languages_so_two_runs_of_the_same_diff_resolve_the_same_way() {
    let lookup = path(&["gopls", "rust-analyzer", "zls"]);
    let one = resolve_servers([Zig, Rust, Go], &none(), &lookup);
    let two = resolve_servers([Go, Zig, Rust], &none(), &lookup);
    assert_eq!(one.servers, two.servers);
    assert_eq!(one.servers.iter().map(|s| s.command.as_str()).collect::<Vec<_>>(), ["gopls", "rust-analyzer", "zls"]);
}

#[test]
fn uses_an_override_without_probing_it_and_reads_an_empty_one_as_off() {
    let probed = Arc::new(Mutex::new(Vec::new()));
    let record = probed.clone();
    let lookup: Lookup = Arc::new(move |c: &str| {
        record.lock().unwrap().push(c.to_owned());
        None
    });
    let overrides = HashMap::from([(Python, "  my-server --stdio  ".to_owned()), (Rust, String::new())]);
    let r = resolve_servers([Python, Rust, Go], &overrides, &lookup);
    assert_eq!(r.servers, [server("my-server --stdio", &[Python], &[])]);
    // An off language names nothing to install; a language with no server on PATH does.
    assert_eq!(
        missing(&r.missing),
        json!([{ "language": "go", "tried": ["gopls"] }, { "language": "rust", "tried": [] }])
    );
    assert_eq!(*probed.lock().unwrap(), candidates_for(Go));
}

/// A `vue-language-server` laid out as nixpkgs does, with the tsserver plugin beside it.
fn vue_language_server(root: &Path) -> PathBuf {
    let plugin = root.join("lib/language-tools/packages/language-server/node_modules/@vue/typescript-plugin");
    std::fs::create_dir_all(&plugin).unwrap();
    std::fs::write(plugin.join("package.json"), r#"{"name":"@vue/typescript-plugin","main":"i.js"}"#).unwrap();
    std::fs::write(plugin.join("i.js"), "").unwrap();
    std::fs::create_dir_all(root.join("bin")).unwrap();
    std::fs::write(root.join("bin/vue-language-server"), "#!/bin/sh\nexit 0\n").unwrap();
    root.join("bin/vue-language-server")
}

#[test]
fn routes_vue_to_a_typescript_server_only_beside_the_plugin_vue_language_server_ships() {
    // Nothing installed: every program a candidate would need, in candidate order.
    let tried = |r: &diffle::lsp::registry::Resolution| missing(&r.missing);
    assert_eq!(
        tried(&resolve_servers([Vue], &none(), &path(&[]))),
        json!([{ "language": "vue", "tried": ["typescript-language-server", "vue-language-server", "vtsls"] }])
    );
    // The TypeScript server alone names what is still to install, not what is already there.
    assert_eq!(
        tried(&resolve_servers([Vue], &none(), &path(&["typescript-language-server"]))),
        json!([{ "language": "vue", "tried": ["vue-language-server", "vtsls"] }])
    );
    // On PATH, but with nothing beside it tsserver could load: as good as absent, and said so.
    let bare =
        resolve_servers([Vue, Typescript], &none(), &path(&["typescript-language-server", "vue-language-server"]));
    assert_eq!(bare.servers, [server("typescript-language-server --stdio", &[Typescript], &[])]);
    assert_eq!(
        tried(&bare),
        json!([{ "language": "vue", "tried": ["vtsls"], "why": "vue-language-server is on PATH but @vue/typescript-plugin was not found beside it" }])
    );
    let dir = tempfile::tempdir().unwrap();
    let installed = vue_language_server(&dunce::canonicalize(dir.path()).unwrap());
    let ts = path(&["typescript-language-server"]);
    let lookup: Lookup =
        Arc::new(move |c: &str| if c.starts_with("vue-language-server") { Some(installed.clone()) } else { ts(c) });
    let r = resolve_servers([Vue, Typescript], &none(), &lookup);
    assert_eq!(r.servers, [server("typescript-language-server --stdio", &[Typescript, Vue], &[])]);
    assert!(r.missing.is_empty());
}

#[test]
fn starts_a_joining_server_for_any_language_it_joins_joining_only_the_asked_ones() {
    let tailwind = "tailwindcss-language-server --stdio";
    let both = resolve_servers([Typescriptreact, Python], &none(), &path(&["vtsls", "tailwindcss-language-server"]));
    assert_eq!(
        both.servers,
        [server("vtsls --stdio", &[Typescriptreact], &[]), server(tailwind, &[], &[Typescriptreact])]
    );
    // Python is not joined, so it is missing as before; an absent joiner is nobody's missing server.
    let programs: Vec<String> =
        candidates_for(Python).iter().map(|c| c.split(' ').next().unwrap().to_owned()).collect();
    assert_eq!(missing(&both.missing), json!([{ "language": "python", "tried": programs }]));
    assert!(resolve_servers([Python], &none(), &path(&["tailwindcss-language-server"])).servers.is_empty());
    let alone = resolve_servers([Css], &none(), &path(&["tailwindcss-language-server"]));
    assert_eq!(alone.servers.iter().map(|s| s.command.as_str()).collect::<Vec<_>>(), [tailwind]);
    assert_eq!(missing(&alone.missing), json!([{ "language": "css", "tried": ["vscode-css-language-server"] }]));
    assert!(resolve_servers([Css], &none(), &path(&[])).servers.is_empty());
}

#[test]
fn probes_each_candidate_once_however_many_languages_ask_for_it() {
    let probed = Arc::new(Mutex::new(Vec::new()));
    let record = probed.clone();
    let lookup: Lookup = Arc::new(move |c: &str| {
        record.lock().unwrap().push(c.to_owned());
        None
    });
    resolve_servers([Typescript, Typescriptreact, Javascript, Javascriptreact], &none(), &lookup);
    let probed = probed.lock().unwrap().clone();
    assert_eq!(probed.len(), probed.iter().collect::<std::collections::HashSet<_>>().len(), "{probed:?}");
}

#[tokio::test]
async fn configures_a_command_by_its_program_however_it_is_spelled_and_an_unknown_one_not_at_all() {
    let ctx = ServerContext { root: "/repo".into(), paths: Vec::new(), lookup: Arc::new(|_: &str| None) };
    assert!(definition_of("tombi lsp").settings.is_none());
    // The VS Code CSS server's linter crashes on a null `lint` section, and nobody reads its diagnostics.
    let css = definition_of("vscode-css-language-server --stdio").settings.unwrap()(&ctx).await;
    assert_eq!(
        css,
        json!({ "css": { "validate": false }, "less": { "validate": false }, "scss": { "validate": false } })
    );
    let taplo = definition_of(r#""C:\tools\taplo.exe" lsp stdio"#).settings.unwrap()(&ctx).await;
    assert_eq!(taplo.pointer("/evenBetterToml/schema/enabled"), Some(&json!(true)));
    let unknown = definition_of("my-server --stdio");
    assert_eq!(unknown.command, "my-server --stdio");
    assert!(unknown.settings.is_none() && unknown.initialization_options.is_none() && unknown.projects.is_none());
    assert!(!unknown.reconfigures);
}

#[test]
fn knows_a_server_for_every_language_it_recognizes() {
    let plain = regex::Regex::new(r"^[\w.-]+( [-\w.=/]+)*$").unwrap();
    for language in language_ids() {
        let commands = candidates_for(language);
        assert!(!commands.is_empty(), "{language:?}");
        // Candidate commands are plain `prog arg…` lines, so their first word is a program to probe.
        for command in commands {
            assert!(plain.is_match(&command), "{command}");
        }
    }
}
