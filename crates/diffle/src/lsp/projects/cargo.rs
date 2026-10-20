//! The Cargo workspaces a diff reaches, which rust-analyzer loads as `linkedProjects`.
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Value, json};

use super::shown::shown_path;
use crate::lsp::registry::ServerContext;
use crate::protocol::LspProjects;

const MANIFEST: &str = "Cargo.toml";
/// A `[workspace]` table header, or a sub-table's (`[workspace.dependencies]`), which declares it too.
static WORKSPACE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^[ \t]*\[workspace(\.[^\]]*)?\][ \t]*(#.*)?$").unwrap());

/// The Cargo workspaces behind `paths` (repository-relative), as absolute manifest paths, sorted.
/// A file's workspace is the nearest manifest declaring `[workspace]` at or above its crate's, else
/// the crate's own. rust-analyzer's discovery stops at the root's manifest, so a separate workspace
/// below it would go unloaded; naming projects replaces that discovery, so the root's manifest is
/// always named too. Empty when there is none.
pub fn cargo_workspaces(root: &Path, paths: &[String]) -> Vec<PathBuf> {
    let mut found: Vec<String> = Vec::new();
    let mut add = |manifest: PathBuf| {
        let manifest = manifest.to_string_lossy().into_owned();
        if !found.contains(&manifest) {
            found.push(manifest);
        }
    };
    if root.join(MANIFEST).exists() {
        add(root.join(MANIFEST));
    }
    let mut dirs: Vec<&Path> = paths.iter().map(|p| Path::new(p).parent().unwrap_or(Path::new(""))).collect();
    dirs.dedup();
    for dir in dirs {
        if let Some(workspace) = workspace_of(root, dir) {
            add(workspace);
        }
    }
    found.sort();
    found.into_iter().map(PathBuf::from).collect()
}

fn workspace_of(root: &Path, dir: &Path) -> Option<PathBuf> {
    let mut krate = None;
    for d in dir.ancestors() {
        let manifest = root.join(d).join(MANIFEST);
        if manifest.exists() {
            if declares_workspace(&manifest) {
                return Some(manifest);
            }
            krate.get_or_insert(manifest);
        }
    }
    krate
}

fn declares_workspace(manifest: &Path) -> bool {
    std::fs::read_to_string(manifest).is_ok_and(|text| WORKSPACE.is_match(&text))
}

/// rust-analyzer's `linkedProjects`: every Cargo workspace the diff reaches, when there is one.
pub fn linked_projects(ctx: &ServerContext) -> Option<Value> {
    let projects = cargo_workspaces(&ctx.root, &ctx.paths);
    let projects: Vec<String> = projects.iter().map(|p| p.to_string_lossy().into_owned()).collect();
    (!projects.is_empty()).then(|| json!({ "linkedProjects": projects }))
}

/// The workspaces `linked_projects` names, for the status.
pub fn cargo_projects(ctx: &ServerContext) -> LspProjects {
    let paths = cargo_workspaces(&ctx.root, &ctx.paths).iter().map(|m| shown_path(&ctx.root, m)).collect();
    LspProjects { label: "Cargo workspaces".into(), paths }
}
