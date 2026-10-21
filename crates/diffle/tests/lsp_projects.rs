//! What servers are pointed at: Cargo workspaces, the project's TypeScript, the Vue plugin.
use std::path::{Path, PathBuf};
use std::sync::Arc;

use diffle::lsp::projects::cargo::cargo_workspaces;
use diffle::lsp::projects::tsdk::tsdk_location;
use diffle::lsp::projects::vue::vue_plugin_location;
use diffle::lsp::registry::{Lookup, ServerContext, definition_of};
use serde_json::json;

/// `rel` under `base` with native separators, so an expectation compares equal on Windows too.
fn at(base: &Path, rel: &str) -> PathBuf {
    rel.split('/').fold(base.to_path_buf(), |p, c| p.join(c))
}

fn tmp() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    // Canonical, so a location reached through a symlink compares equal to the one laid out.
    let path = dunce::canonicalize(dir.path()).unwrap();
    (dir, path)
}

fn write(root: &Path, path: &str, text: &str) {
    let file = root.join(path);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, text).unwrap();
}

fn executable(at: &Path) -> PathBuf {
    std::fs::create_dir_all(at.parent().unwrap()).unwrap();
    std::fs::write(at, "#!/bin/sh\nexit 0\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(at, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    at.to_path_buf()
}

fn ctx(root: &Path, paths: &[&str], lookup: Lookup) -> ServerContext {
    ServerContext { root: root.to_path_buf(), paths: paths.iter().map(|p| (*p).to_owned()).collect(), lookup }
}

fn nothing() -> Lookup {
    Arc::new(|_: &str| None)
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// conda/rattler's layout: a root workspace over `crates/*`, and bindings that are workspaces of their own.
fn rattler(root: &Path) {
    write(root, "Cargo.toml", "[workspace]\nmembers = [\"crates/*\"]\nresolver = \"2\"\n");
    write(root, "crates/rattler/Cargo.toml", "[package]\nname = \"rattler\"\n");
    write(
        root,
        "py-rattler/Cargo.toml",
        "[package]\nname = \"py-rattler\"\n\n# Not in the root workspace\n[workspace]\n",
    );
    write(root, "js-rattler/Cargo.toml", "[package]\nname = \"js-rattler\"\n\n[workspace] # its own\n");
}

fn paths(list: &[&str]) -> Vec<String> {
    list.iter().map(|p| (*p).to_owned()).collect()
}

#[test]
fn names_the_workspace_behind_each_file_and_the_roots_always() {
    let (_dir, root) = tmp();
    rattler(&root);
    assert_eq!(
        cargo_workspaces(&root, &paths(&["crates/rattler/src/lib.rs", "crates/rattler/src/install/mod.rs"])),
        [root.join("Cargo.toml")]
    );
    assert_eq!(
        cargo_workspaces(&root, &paths(&["py-rattler/src/lib.rs", "js-rattler/src/lib.rs", "crates/rattler/build.rs"])),
        [root.join("Cargo.toml"), at(&root, "js-rattler/Cargo.toml"), at(&root, "py-rattler/Cargo.toml")]
    );
    assert_eq!(cargo_workspaces(&root, &[]), [root.join("Cargo.toml")]);
}

#[test]
fn takes_the_crate_itself_when_no_manifest_above_it_declares_a_workspace() {
    let (_dir, root) = tmp();
    assert!(cargo_workspaces(&root, &paths(&["tool/src/main.rs"])).is_empty());
    write(&root, "tool/Cargo.toml", "[package]\nname = \"tool\"\n");
    // A workspace sub-table declares the workspace as well; a key merely named like one does not.
    write(&root, "other/Cargo.toml", "[workspace.dependencies]\nserde = \"1\"\n");
    write(&root, "other/member/Cargo.toml", "[package]\nname = \"member\"\nworkspace_note = \"[workspace]\"\n");
    assert_eq!(
        cargo_workspaces(&root, &paths(&["tool/src/main.rs", "other/member/src/lib.rs"])),
        [at(&root, "other/Cargo.toml"), at(&root, "tool/Cargo.toml")]
    );
}

#[tokio::test]
async fn reach_rust_analyzer_as_linked_projects_at_initialize_and_in_its_settings() {
    let (_dir, root) = tmp();
    rattler(&root);
    let c = ctx(&root, &["py-rattler/src/lib.rs"], nothing());
    let linked = json!([s(&root.join("Cargo.toml")), s(&at(&root, "py-rattler/Cargo.toml"))]);
    let definition = definition_of("rust-analyzer");
    assert_eq!(definition.initialization_options.unwrap()(&c), Some(json!({ "linkedProjects": linked })));
    assert_eq!(definition.settings.unwrap()(&c).await, json!({ "rust-analyzer": { "linkedProjects": linked } }));
    assert!(definition.reconfigures);
    let projects = definition.projects.unwrap()(&c);
    assert_eq!(
        (projects.label.as_str(), projects.paths),
        ("Cargo workspaces", vec!["Cargo.toml".to_owned(), "py-rattler/Cargo.toml".to_owned()])
    );
    let bare = ctx(&root.join("crates"), &[], nothing());
    assert_eq!(definition.initialization_options.unwrap()(&bare), None);
    assert_eq!(definition.settings.unwrap()(&bare).await, json!({}));
    assert!(definition.projects.unwrap()(&bare).paths.is_empty());
}

/// A `typescript` package under `modules`; TypeScript 7 ships no `lib/typescript.js`. Returns its lib.
fn typescript(modules: &Path, version: &str) -> PathBuf {
    let dir = modules.join("typescript");
    let lib = dir.join("lib");
    std::fs::create_dir_all(&lib).unwrap();
    std::fs::write(dir.join("package.json"), json!({ "name": "typescript", "version": version }).to_string()).unwrap();
    std::fs::write(lib.join(if version.starts_with('7') { "tsc.js" } else { "typescript.js" }), "").unwrap();
    lib
}

#[test]
fn prefers_the_repositorys_typescript_to_the_servers() {
    let (_dir, root) = tmp();
    let repo = typescript(&at(&root, "repo/node_modules"), "6.0.3");
    typescript(&at(&root, "bin/node_modules"), "6.0.3");
    let found = tsdk_location(&root.join("repo"), &[], &[Some(executable(&at(&root, "bin/astro-ls")))]);
    assert_eq!(found, Some(repo));
}

// Windows: creating a symlink needs a privilege the CI runner lacks.
#[cfg(unix)]
#[test]
fn follows_the_npm_symlink_to_the_typescript_hoisted_beside_the_package() {
    let (_dir, root) = tmp();
    let modules = at(&root, "lib/node_modules");
    write(&modules, "@astrojs/language-server/bin/nodeServer.js", "");
    let lib = typescript(&modules, "6.0.3");
    std::fs::create_dir(root.join("bin")).unwrap();
    std::os::unix::fs::symlink(
        "../lib/node_modules/@astrojs/language-server/bin/nodeServer.js",
        at(&root, "bin/astro-ls"),
    )
    .unwrap();
    assert_eq!(tsdk_location(&root.join("repo"), &[], &[Some(at(&root, "bin/astro-ls"))]), Some(lib));
}

#[test]
fn finds_the_typescript_beside_a_windows_shim() {
    let (_dir, bin) = tmp();
    let lib = typescript(&bin.join("node_modules"), "6.0.3");
    write(&bin, "astro-ls.cmd", "@node \"%~dp0\\node_modules\\@astrojs\\language-server\\bin\\nodeServer.js\" %*\n");
    assert_eq!(tsdk_location(&bin.join("repo"), &[], &[Some(bin.join("astro-ls.cmd"))]), Some(lib));
}

#[cfg(unix)]
#[test]
fn reaches_through_the_pnpm_store_nixpkgs_lays_out() {
    let (_dir, root) = tmp();
    let pkg = at(&root, "lib/node_modules/astro-language-server/packages/language-tools/language-server");
    write(&pkg, "bin/nodeServer.js", "");
    let store = at(&root, "lib/node_modules/astro-language-server/node_modules/.pnpm/typescript@6.0.3/node_modules");
    let lib = typescript(&store, "6.0.3");
    std::fs::create_dir(pkg.join("node_modules")).unwrap();
    std::os::unix::fs::symlink(lib.parent().unwrap(), at(&pkg, "node_modules/typescript")).unwrap();
    std::fs::create_dir(root.join("bin")).unwrap();
    std::os::unix::fs::symlink(at(&pkg, "bin/nodeServer.js"), at(&root, "bin/astro-ls")).unwrap();
    assert_eq!(tsdk_location(&root.join("repo"), &[], &[Some(at(&root, "bin/astro-ls"))]), Some(lib));
}

#[test]
fn reaches_a_conda_environments_packages_through_a_pixi_trampoline() {
    let (_dir, root) = tmp();
    let prefix = at(&root, "envs/astro-ls");
    let launcher = executable(&at(&prefix, "bin/astro-ls"));
    let trampoline = executable(&at(&root, "bin/astro-ls"));
    write(&root, "bin/trampoline_configuration/astro-ls.json", &json!({ "exe": s(&launcher) }).to_string());
    // Nested under the server package, as the conda package lays it out.
    let nested = typescript(&at(&prefix, "lib/node_modules/@astrojs/language-server/node_modules"), "6.0.3");
    assert_eq!(tsdk_location(&root.join("repo"), &[], &[Some(trampoline)]), Some(nested));
    // A TypeScript 7 there is passed over for one hoisted beside the package.
    let other = at(&root, "envs/other");
    typescript(&at(&other, "lib/node_modules/@astrojs/language-server/node_modules"), "7.0.2");
    let hoisted = typescript(&at(&other, "lib/node_modules"), "6.0.3");
    assert_eq!(tsdk_location(&root.join("repo"), &[], &[Some(executable(&at(&other, "bin/astro-ls")))]), Some(hoisted));
}

#[test]
fn finds_a_packages_typescript_below_the_root_from_the_diffs_files() {
    let (_dir, root) = tmp();
    let repo = root.join("repo");
    let frontend = typescript(&at(&repo, "frontend/node_modules"), "5.9.3");
    let global = typescript(&at(&root, "bin/node_modules"), "6.0.3");
    let server = [Some(executable(&at(&root, "bin/typescript-language-server")))];
    assert_eq!(
        tsdk_location(&repo, &paths(&["frontend/src/app/main.ts", "README.md"]), &server),
        Some(frontend.clone())
    );
    // Files elsewhere in the repository reach no project of their own.
    assert_eq!(tsdk_location(&repo, &paths(&["scripts/build.ts"]), &server), Some(global));
    // With a TypeScript at the root too, the first file's project wins.
    let top = typescript(&repo.join("node_modules"), "6.0.3");
    assert_eq!(tsdk_location(&repo, &paths(&["scripts/build.ts", "frontend/src/a.ts"]), &server), Some(top));
    assert_eq!(tsdk_location(&repo, &paths(&["frontend/src/a.ts", "scripts/build.ts"]), &server), Some(frontend));
}

#[test]
fn passes_over_typescript_7_and_over_nothing_at_all() {
    let (_dir, root) = tmp();
    typescript(&at(&root, "repo/node_modules"), "7.0.2");
    let bin = root.join("bin");
    typescript(&bin.join("node_modules"), "7.0.2");
    let astro = executable(&bin.join("astro-ls"));
    assert_eq!(tsdk_location(&root.join("repo"), &[], &[Some(astro.clone()), None, Some(bin.join("missing"))]), None);
    let other = typescript(&at(&bin, "other/node_modules"), "6.0.3");
    let vtsls = executable(&at(&bin, "other/vtsls"));
    assert_eq!(tsdk_location(&root.join("repo"), &[], &[Some(astro), Some(vtsls)]), Some(other));
}

fn programs_at(bin: PathBuf, programs: &'static [&'static str]) -> Lookup {
    Arc::new(move |command: &str| {
        let program = command.split(' ').next().unwrap_or_default();
        programs.contains(&program).then(|| executable(&bin.join(program)))
    })
}

#[test]
fn astro_ls_takes_its_typescript_at_initialize_from_the_repository_else_beside_a_server_on_path() {
    let (_dir, root) = tmp();
    let lib = typescript(&at(&root, "bin/node_modules"), "6.0.3");
    let options = definition_of("astro-ls --stdio").initialization_options.unwrap();
    let repo = root.join("repo");
    assert_eq!(
        options(&ctx(&repo, &[], programs_at(root.join("bin"), &["astro-ls"]))),
        Some(json!({ "typescript": { "tsdk": s(&lib) } }))
    );
    // astro-ls on PATH beside no TypeScript, but a TypeScript server beside one elsewhere.
    let elsewhere = typescript(&at(&root, "elsewhere/node_modules"), "6.0.3");
    let (bare, other) = (at(&root, "bare/astro-ls"), at(&root, "elsewhere/vtsls"));
    let lookup: Lookup = Arc::new(move |c: &str| {
        if c.starts_with("astro-ls") {
            Some(executable(&bare))
        } else if c.starts_with("vtsls") {
            Some(executable(&other))
        } else {
            None
        }
    });
    assert_eq!(options(&ctx(&repo, &[], lookup)), Some(json!({ "typescript": { "tsdk": s(&elsewhere) } })));
    assert_eq!(options(&ctx(&repo, &[], nothing())), None);
    assert!(definition_of("vtsls --stdio").initialization_options.is_none());
}

#[tokio::test]
async fn the_typescript_servers_take_the_projects_typescript_and_the_status_names_it() {
    let (_dir, root) = tmp();
    let lib = typescript(&at(&root, "frontend/node_modules"), "5.9.3");
    let c = ctx(&root, &["frontend/src/index.ts"], nothing());
    let tsserver = definition_of("typescript-language-server --stdio");
    assert_eq!(tsserver.initialization_options.unwrap()(&c), Some(json!({ "tsserver": { "path": s(&lib) } })));
    let vtsls = definition_of("vtsls --stdio");
    assert_eq!(
        vtsls.settings.unwrap()(&c).await,
        json!({ "typescript": { "tsdk": s(&lib) }, "vtsls": { "autoUseWorkspaceTsdk": true } })
    );
    let none = ctx(&root, &["src/index.ts"], nothing());
    assert_eq!(tsserver.initialization_options.unwrap()(&none), None);
    assert_eq!(vtsls.settings.unwrap()(&none).await, json!({}));
    for command in ["typescript-language-server --stdio", "vtsls --stdio", "astro-ls --stdio"] {
        let projects = definition_of(command).projects.unwrap()(&c);
        assert_eq!(
            (projects.label.as_str(), projects.paths),
            ("TypeScript 5.9.3", vec!["frontend/node_modules/typescript".to_owned()])
        );
    }
    let empty = vtsls.projects.unwrap()(&ctx(&root, &[], nothing()));
    assert_eq!((empty.label.as_str(), empty.paths.len()), ("TypeScript", 0));
}

/// A package directory with a package.json, optionally with its own `main` module.
fn pkg(dir: &Path, name: &str, main: Option<&str>) -> PathBuf {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join("package.json"), json!({ "name": name, "version": "3.0.0", "main": main }).to_string())
        .unwrap();
    if let Some(main) = main {
        std::fs::write(dir.join(main), "module.exports = () => ({});\n").unwrap();
    }
    dir.to_path_buf()
}

/// The nixpkgs monorepo beside its wrapper; returns the executable and the plugin location.
fn nix_layout(root: &Path) -> (PathBuf, PathBuf) {
    let location = pkg(&at(root, "lib/language-tools/packages/language-server"), "@vue/language-server", None);
    pkg(&at(&location, "node_modules/@vue/typescript-plugin"), "@vue/typescript-plugin", Some("index.js"));
    (executable(&at(root, "bin/vue-language-server")), location)
}

// Windows: creating a symlink needs a privilege the CI runner lacks.
#[cfg(unix)]
#[test]
fn follows_the_npm_symlink_into_the_package() {
    let (_dir, root) = tmp();
    let modules = at(&root, "lib/node_modules");
    let location = pkg(&at(&modules, "@vue/language-server"), "@vue/language-server", None);
    pkg(&at(&modules, "@vue/typescript-plugin"), "@vue/typescript-plugin", Some("index.js"));
    write(&location, "bin/vue-language-server.js", "#!/usr/bin/env node\n");
    std::fs::create_dir(root.join("bin")).unwrap();
    std::os::unix::fs::symlink(
        "../lib/node_modules/@vue/language-server/bin/vue-language-server.js",
        at(&root, "bin/vue-language-server"),
    )
    .unwrap();
    assert_eq!(vue_plugin_location(&at(&root, "bin/vue-language-server")), Some(location));
}

#[test]
fn finds_the_vue_package_beside_a_windows_shim_and_the_nixpkgs_wrapper() {
    let (_dir, bin) = tmp();
    let location = pkg(&at(&bin, "node_modules/@vue/language-server"), "@vue/language-server", None);
    pkg(&at(&location, "node_modules/@vue/typescript-plugin"), "@vue/typescript-plugin", Some("index.js"));
    write(
        &bin,
        "vue-language-server.cmd",
        "@node \"%~dp0\\node_modules\\@vue\\language-server\\bin\\vue-language-server.js\" %*\n",
    );
    assert_eq!(vue_plugin_location(&bin.join("vue-language-server.cmd")), Some(location));
    let (_dir, root) = tmp();
    let (executable, location) = nix_layout(&root);
    assert_eq!(vue_plugin_location(&executable), Some(location));
}

/// A conda environment: a launcher script in `bin` beside `lib/node_modules`, where the plugin is
/// nested under the language-server package.
fn conda_layout(prefix: &Path) -> (PathBuf, PathBuf) {
    let location = pkg(&at(prefix, "lib/node_modules/@vue/language-server"), "@vue/language-server", None);
    pkg(&at(&location, "node_modules/@vue/typescript-plugin"), "@vue/typescript-plugin", Some("index.js"));
    (executable(&at(prefix, "bin/vue-language-server")), location)
}

#[test]
fn finds_the_vue_package_beside_a_conda_launcher_and_through_a_pixi_trampoline() {
    let (_dir, root) = tmp();
    let (launcher, location) = conda_layout(&at(&root, "envs/vue-language-server"));
    assert_eq!(vue_plugin_location(&launcher), Some(location.clone()));
    // The file on PATH is a native launcher; its configuration beside it names the real program.
    let trampoline = executable(&at(&root, "bin/vue-language-server"));
    let config = "bin/trampoline_configuration/vue-language-server.json";
    write(
        &root,
        config,
        &json!({ "exe": s(&launcher), "path_diff": s(&at(&root, "envs/vue-language-server/bin")) }).to_string(),
    );
    assert_eq!(vue_plugin_location(&trampoline), Some(location));
    // A configuration naming nothing usable is ignored.
    write(&root, config, r#"{"exe": 1}"#);
    assert_eq!(vue_plugin_location(&trampoline), None);
}

#[test]
fn gives_up_on_a_layout_without_the_plugin() {
    let (_dir, root) = tmp();
    pkg(&at(&root, "lib/language-tools/packages/language-server"), "@vue/language-server", None);
    assert_eq!(vue_plugin_location(&executable(&at(&root, "bin/vue-language-server"))), None);
    assert_eq!(vue_plugin_location(&at(&root, "bin/missing")), None);
}

#[tokio::test]
async fn typescript_servers_load_the_vue_plugin_as_initialization_options_or_settings() {
    let (_dir, root) = tmp();
    let (executable, location) = nix_layout(&root);
    let found: Lookup = Arc::new(move |c: &str| (c == "vue-language-server").then(|| executable.clone()));
    let plugin = json!({ "name": "@vue/typescript-plugin", "location": s(&location), "languages": ["vue"] });
    let tsserver = definition_of("typescript-language-server --stdio");
    assert_eq!(
        tsserver.initialization_options.unwrap()(&ctx(&root, &[], found.clone())),
        Some(json!({ "plugins": [plugin] }))
    );
    assert_eq!(tsserver.initialization_options.unwrap()(&ctx(&root, &[], nothing())), None);
    assert!(tsserver.settings.is_none());
    let vtsls = definition_of("vtsls --stdio");
    assert!(vtsls.initialization_options.is_none());
    let mut namespaced = plugin.clone();
    namespaced["configNamespace"] = json!("typescript");
    let settings = vtsls.settings.unwrap()(&ctx(&root, &[], found)).await;
    assert_eq!(settings, json!({ "vtsls": { "tsserver": { "globalPlugins": [namespaced] } } }));
    assert_eq!(vtsls.settings.unwrap()(&ctx(&root, &[], nothing())).await, json!({}));
}
