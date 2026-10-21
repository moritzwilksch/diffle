//! The tsserver plugin that turns .vue files into TypeScript documents, found beside `vue-language-server`.
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::resolve_package;
use crate::lsp::registry::Lookup;
use crate::lsp::which::real_executable;

pub const VUE_PLUGIN: &str = "@vue/typescript-plugin";

/// Where tsserver loads the Vue plugin from, given the `vue-language-server` executable, or none
/// when no package holding the plugin is found beside it. Vue language tools 3 serve .vue files
/// through this plugin inside tsserver; the standalone server only relays to a tsserver the editor
/// must bridge, so diffle never runs it. Reached through the layouts of npm (a symlink into the
/// package, or a `.cmd` shim beside `node_modules`), conda and pixi (a launcher in `bin` beside
/// `lib/node_modules`, behind a pixi global trampoline), and nixpkgs (beside `lib/language-tools`).
pub fn vue_plugin_location(executable: &Path) -> Option<PathBuf> {
    let real = real_executable(executable);
    let bin = real.parent().unwrap_or(Path::new(""));
    let up = bin.parent().unwrap_or(Path::new(""));
    // Joined a component at a time: a slash inside one would stay a slash on Windows.
    let candidates = [
        up.to_path_buf(),
        executable.parent().unwrap_or(Path::new("")).join("node_modules").join("@vue").join("language-server"),
        up.join("lib").join("node_modules").join("@vue").join("language-server"),
        up.join("lib").join("language-tools").join("packages").join("language-server"),
    ];
    // The same walk up `node_modules` tsserver makes from the location it is given.
    candidates.into_iter().find(|dir| resolve_package(dir, VUE_PLUGIN).is_some())
}

/// The tsserver plugin entry for .vue files when `vue-language-server` is on PATH. Loaded whenever
/// a TypeScript server starts, not only when the diff holds a .vue file: a process serving .ts
/// files first cannot load it later, and .ts files importing components resolve them.
pub fn vue_plugin(lookup: &Lookup) -> Option<Value> {
    let location = vue_plugin_location(&lookup("vue-language-server")?)?;
    Some(json!({ "name": VUE_PLUGIN, "location": location.to_string_lossy(), "languages": ["vue"] }))
}
