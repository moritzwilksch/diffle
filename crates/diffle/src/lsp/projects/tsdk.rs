//! The TypeScript a server should read code with: the project's, else one beside a server on PATH.
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use super::resolve_package;
use super::shown::shown_path;
use crate::lsp::registry::ServerContext;
use crate::lsp::which::real_executable;
use crate::protocol::LspProjects;

/// Programs whose installations may carry a TypeScript.
const TSSERVER_PROGRAMS: [&str; 3] = ["typescript-language-server", "vtsls", "astro-ls"];

/// The TypeScript `lib` a server named `program` loads: the project's, found from the diff's files
/// so a package below the root has its own, else one beside a server on PATH, its own first.
pub fn tsdk(ctx: &ServerContext, program: &str) -> Option<PathBuf> {
    let programs = std::iter::once(program).chain(TSSERVER_PROGRAMS.into_iter().filter(|p| *p != program));
    let executables: Vec<Option<PathBuf>> = programs.map(|p| (ctx.lookup)(p)).collect();
    tsdk_location(&ctx.root, &ctx.paths, &executables)
}

/// The TypeScript `tsdk` finds, for the status: its version and package.
pub fn typescript_projects(ctx: &ServerContext, program: &str) -> LspProjects {
    let Some(lib) = tsdk(ctx, program) else { return LspProjects { label: "TypeScript".into(), paths: Vec::new() } };
    let label = typescript_version(&lib).map_or_else(|| "TypeScript".to_owned(), |v| format!("TypeScript {v}"));
    LspProjects { label, paths: vec![shown_path(&ctx.root, lib.parent().unwrap_or(&lib))] }
}

/// The TypeScript `lib` directory a server loads as its tsdk. The project's own `typescript` wins,
/// resolved from the directory of each of `paths` (repository-relative), then from `root`. After
/// it, the one installed beside the first of `executables` that has one, from the executable's
/// real location (npm, a Windows `.cmd` shim, the pnpm store nixpkgs lays out), and from each
/// package under a conda or pixi environment's `lib/node_modules`. TypeScript 7 ships no
/// `typescript.js`, so it is passed over: no tsserver client can load the Go port.
pub fn tsdk_location(root: &Path, paths: &[String], executables: &[Option<PathBuf>]) -> Option<PathBuf> {
    // Resolution walks up `node_modules` from each base, so one base per directory reaches every ancestor.
    let mut bases: Vec<PathBuf> =
        paths.iter().map(|p| root.join(Path::new(p).parent().unwrap_or(Path::new("")))).collect();
    bases.push(root.to_path_buf());
    for executable in executables.iter().flatten() {
        let real = real_executable(executable);
        let bin = real.parent().unwrap_or(Path::new("")).to_path_buf();
        let modules = bin.parent().unwrap_or(Path::new("")).join("lib").join("node_modules");
        bases.push(bin);
        bases.extend(global_packages(&modules));
    }
    let mut seen = BTreeSet::new();
    bases.into_iter().filter(|b| seen.insert(b.clone())).find_map(|base| typescript_lib(&base))
}

/// The version a `lib` from `tsdk_location` belongs to, from its package.
fn typescript_version(lib: &Path) -> Option<String> {
    let text = std::fs::read_to_string(lib.parent()?.join("package.json")).ok()?;
    let package: serde_json::Value = serde_json::from_str(&text).ok()?;
    package.get("version")?.as_str().map(str::to_owned)
}

/// The package directories under a global `node_modules`, scoped ones included.
fn global_packages(modules: &Path) -> Vec<PathBuf> {
    let entries = |dir: &Path| -> Vec<String> {
        let Ok(read) = std::fs::read_dir(dir) else { return Vec::new() };
        let mut names: Vec<String> = read
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir() || t.is_symlink()))
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    };
    entries(modules)
        .into_iter()
        .flat_map(|name| {
            if name.starts_with('@') {
                entries(&modules.join(&name)).into_iter().map(|sub| modules.join(&name).join(sub)).collect()
            } else {
                vec![modules.join(name)]
            }
        })
        .collect()
}

/// `typescript/lib` as resolved from `base`, when it holds a loadable TypeScript.
fn typescript_lib(base: &Path) -> Option<PathBuf> {
    let lib = resolve_package(base, "typescript")?.join("lib");
    ["typescript.js", "tsserverlibrary.js"].iter().any(|f| lib.join(f).exists()).then_some(lib)
}
