//! The language servers diffle knows how to start, in preference order, and how each is configured.
use std::path::{Path, PathBuf};

use futures::FutureExt;
use futures::future::BoxFuture;
use serde_json::{Map, Value, json};

use super::cargo::{cargo_projects, linked_projects};
use super::tsdk::{tsdk, typescript_projects};
use super::vue::{VUE_PLUGIN, vue_plugin, vue_plugin_location};
use crate::lsp::configuration::{SCHEMA_CATALOG, load_schema_catalog};
use crate::lsp::registry::{ServerContext, SettingsFn};
use crate::protocol::LanguageId::{self, *};
use crate::protocol::LspProjects;

/// A second program a candidate needs on PATH, and what its command loads from beside it.
pub struct Requirement {
    pub program: &'static str,
    /// What `program` ships for the command, as messages name it.
    pub what: &'static str,
    pub locate: fn(&Path) -> Option<PathBuf>,
}

/// A server diffle knows how to start, and the languages it answers for.
pub struct Candidate {
    pub languages: &'static [LanguageId],
    pub command: &'static str,
    pub settings: Option<SettingsFn>,
    pub initialization_options: Option<fn(&ServerContext) -> Option<Value>>,
    pub projects: Option<fn(&ServerContext) -> LspProjects>,
    pub reconfigures: bool,
    pub requires: Option<Requirement>,
    /// Languages it answers for beside their owner, as an editor extension would: started whenever
    /// one of them is in the diff, never counted as serving it, running alone for one nothing owns.
    pub joins: &'static [LanguageId],
}

const fn plain(languages: &'static [LanguageId], command: &'static str) -> Candidate {
    Candidate {
        languages,
        command,
        settings: None,
        initialization_options: None,
        projects: None,
        reconfigures: false,
        requires: None,
        joins: &[],
    }
}

const fn with_settings(languages: &'static [LanguageId], command: &'static str, settings: SettingsFn) -> Candidate {
    Candidate { settings: Some(settings), ..plain(languages, command) }
}

fn ready(value: Value) -> BoxFuture<'static, Value> {
    async move { value }.boxed()
}

const TYPESCRIPT: &[LanguageId] = &[Typescript, Typescriptreact, Javascript, Javascriptreact];
const VUE: Requirement = Requirement { program: "vue-language-server", what: VUE_PLUGIN, locate: vue_plugin_location };

/// typescript-language-server loads tsserver plugins and its TypeScript from initializationOptions;
/// unless told, it looks for TypeScript only in the root's `node_modules` and beside itself.
const fn tsserver(languages: &'static [LanguageId], requires: Option<Requirement>) -> Candidate {
    Candidate {
        initialization_options: Some(tsserver_options),
        projects: Some(|ctx| typescript_projects(ctx, "typescript-language-server")),
        requires,
        ..plain(languages, "typescript-language-server --stdio")
    }
}

fn tsserver_options(ctx: &ServerContext) -> Option<Value> {
    let plugin = vue_plugin(&ctx.lookup);
    let lib = tsdk(ctx, "typescript-language-server");
    let mut options = Map::new();
    if let Some(plugin) = plugin {
        options.insert("plugins".into(), json!([plugin]));
    }
    if let Some(lib) = lib {
        options.insert("tsserver".into(), json!({ "path": lib.to_string_lossy() }));
    }
    (!options.is_empty()).then_some(Value::Object(options))
}

/// vtsls takes tsserver plugins as settings; the namespace is where Vue's plugin reads its options.
/// It bundles a TypeScript, and reads the project's only when told to.
const fn vtsls(languages: &'static [LanguageId], requires: Option<Requirement>) -> Candidate {
    Candidate {
        settings: Some(vtsls_settings),
        projects: Some(|ctx| typescript_projects(ctx, "vtsls")),
        requires,
        ..plain(languages, "vtsls --stdio")
    }
}

fn vtsls_settings(ctx: &ServerContext) -> BoxFuture<'static, Value> {
    let plugin = vue_plugin(&ctx.lookup);
    let lib = tsdk(ctx, "vtsls");
    let (mut vtsls, mut settings) = (Map::new(), Map::new());
    if let Some(lib) = &lib {
        vtsls.insert("autoUseWorkspaceTsdk".into(), json!(true));
        settings.insert("typescript".into(), json!({ "tsdk": lib.to_string_lossy() }));
    }
    if let Some(mut plugin) = plugin {
        plugin["configNamespace"] = json!("typescript");
        vtsls.insert("tsserver".into(), json!({ "globalPlugins": [plugin] }));
    }
    if !vtsls.is_empty() {
        settings.insert("vtsls".into(), Value::Object(vtsls));
    }
    ready(Value::Object(settings))
}

fn astro_options(ctx: &ServerContext) -> Option<Value> {
    // Without a tsdk the server refuses to initialize; its own message then names the option.
    tsdk(ctx, "astro-ls").map(|lib| json!({ "typescript": { "tsdk": lib.to_string_lossy() } }))
}

fn json_settings(_: &ServerContext) -> BoxFuture<'static, Value> {
    async { json!({ "json": { "schemas": load_schema_catalog(None).await } }) }.boxed()
}

/// Built-in servers, in preference order per language: the first one whose program is on PATH is
/// used. Entries serving several languages become one process, which is how the servers themselves
/// want it (clangd for c and cpp, tsserver for all of js/ts).
static CANDIDATES: [Candidate; 39] = [
    plain(&[Python], "pyrefly lsp"),
    plain(&[Python], "ty server"),
    plain(&[Python], "basedpyright-langserver --stdio"),
    plain(&[Python], "pyright-langserver --stdio"),
    plain(&[Python], "pylsp"),
    plain(&[Python], "jedi-language-server"),
    tsserver(TYPESCRIPT, None),
    vtsls(TYPESCRIPT, None),
    // Vue 3 language tools answer for .vue files from inside tsserver, through the plugin that
    // ships with vue-language-server; the TypeScript servers load it (projects/vue.rs).
    tsserver(&[Vue], Some(VUE)),
    vtsls(&[Vue], Some(VUE)),
    Candidate {
        initialization_options: Some(astro_options),
        projects: Some(|ctx| typescript_projects(ctx, "astro-ls")),
        ..plain(&[Astro], "astro-ls --stdio")
    },
    // At initialize, so the first load has every workspace; as settings too, so a later
    // `workspace/configuration` pull keeps them and a workspace entering the diff reloads.
    Candidate {
        initialization_options: Some(linked_projects),
        settings: Some(|ctx| ready(linked_projects(ctx).map_or_else(|| json!({}), |o| json!({ "rust-analyzer": o })))),
        projects: Some(cargo_projects),
        reconfigures: true,
        ..plain(&[Rust], "rust-analyzer")
    },
    plain(&[Go], "gopls"),
    plain(&[C, Cpp], "clangd"),
    plain(&[Ruby], "ruby-lsp"),
    plain(&[Ruby], "solargraph stdio"),
    plain(&[Java], "jdtls"),
    // Roslyn loads no project unless asked, and C# answers little without the solution behind the file.
    plain(&[Csharp], "roslyn-language-server --stdio --autoLoadProjects"),
    // The pinned nixpkgs roslyn-ls package exposes the assembly name.
    plain(&[Csharp], "Microsoft.CodeAnalysis.LanguageServer --stdio --autoLoadProjects"),
    plain(&[Csharp], "csharp-ls"),
    plain(&[Lua], "lua-language-server"),
    plain(&[Nix], "nixd"),
    plain(&[Nix], "nil"),
    plain(&[Zig], "zls"),
    plain(&[Swift], "sourcekit-lsp"),
    plain(&[Php], "intelephense --stdio"),
    plain(&[Php], "phpactor language-server"),
    plain(&[Shellscript], "bash-language-server start"),
    plain(&[Haskell], "haskell-language-server-wrapper --lsp"),
    plain(&[Ocaml], "ocamllsp"),
    plain(&[Terraform], "terraform-ls serve"),
    with_settings(&[Json, Jsonc], "vscode-json-language-server --stdio", json_settings),
    with_settings(&[Json, Jsonc], "vscode-json-languageserver --stdio", json_settings),
    with_settings(&[Yaml], "yaml-language-server --stdio", |_| {
        ready(json!({ "yaml": { "hover": true, "schemaStore": { "enable": true, "url": SCHEMA_CATALOG } } }))
    }),
    plain(&[Toml], "tombi lsp"),
    with_settings(&[Toml], "taplo lsp stdio", |_| {
        ready(json!({ "evenBetterToml": { "schema": { "enabled": true, "catalogs": [SCHEMA_CATALOG] } } }))
    }),
    // Diagnostics go unread, and the server's linter crashes on a missing `lint` section.
    with_settings(&[Css], "vscode-css-language-server --stdio", |_| {
        ready(json!({ "css": { "validate": false }, "less": { "validate": false }, "scss": { "validate": false } }))
    }),
    plain(&[Html], "vscode-html-language-server --stdio"),
    // Class hovers wherever Tailwind classes appear, beside whatever owns the file.
    Candidate {
        joins: &[Astro, Css, Html, Javascript, Javascriptreact, Typescript, Typescriptreact, Vue],
        ..plain(&[], "tailwindcss-language-server --stdio")
    },
];

pub fn candidates() -> impl Iterator<Item = &'static Candidate> {
    CANDIDATES.iter()
}
