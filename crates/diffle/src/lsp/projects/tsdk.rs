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
    let package = tsdk(ctx, program).and_then(|lib| lib.parent().map(Path::to_path_buf));
    package_projects(&ctx.root, package)
}

/// The TypeScript 7 package `tsc --lsp` runs from, for the status.
pub fn native_projects(ctx: &ServerContext) -> LspProjects {
    package_projects(&ctx.root, (ctx.lookup)("tsc").as_deref().and_then(native_typescript))
}

fn package_projects(root: &Path, package: Option<PathBuf>) -> LspProjects {
    let Some(package) = package else { return LspProjects { label: "TypeScript".into(), paths: Vec::new() } };
    let label = typescript_version(&package).map_or_else(|| "TypeScript".to_owned(), |v| format!("TypeScript {v}"));
    LspProjects { label, paths: vec![shown_path(root, &package)] }
}

/// The `typescript` package a `tsc` executable runs, when it is TypeScript 7 or later: the Go port,
/// which serves LSP itself. Found from the executable's real location (npm's symlink, Homebrew's,
/// a pixi trampoline), else beside it (a Windows `.cmd` shim) or in its environment's packages.
pub fn native_typescript(tsc: &Path) -> Option<PathBuf> {
    let real = real_executable(tsc);
    let bin = real.parent()?;
    // Only where this `tsc` runs from: walking up as Node resolves would leave a pixi environment's
    // TypeScript 6 for the repository's TypeScript 7, and that `tsc` has no `--lsp`.
    let packages = [
        bin.parent().map(Path::to_path_buf),
        Some(bin.join("node_modules").join("typescript")),
        bin.parent().map(|env| env.join("lib").join("node_modules").join("typescript")),
    ];
    packages.into_iter().flatten().find(|package| {
        typescript_version(package)
            .and_then(|v| v.split('.').next().and_then(|major| major.parse::<u32>().ok()))
            .is_some_and(|major| major >= 7)
    })
}

/// The TypeScript `lib` directory a server loads as its tsdk. The project's own `typescript` wins,
/// resolved from the directory of each of `paths` (repository-relative), then from `root`. After
/// it, the one installed beside the first of `executables` that has one, from the executable's
/// real location (npm, a Windows `.cmd` shim, the pnpm store nixpkgs lays out), and from each
/// package under a conda or pixi environment's `lib/node_modules`. TypeScript 7 ships no
/// `typescript.js`, so it is passed over: no tsserver client can load the Go port, which
/// `tsc --lsp` serves instead (`native_typescript`).
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

/// The version of the `typescript` package at `package`.
fn typescript_version(package: &Path) -> Option<String> {
    let text = std::fs::read_to_string(package.join("package.json")).ok()?;
    let manifest: serde_json::Value = serde_json::from_str(&text).ok()?;
    (manifest.get("name")?.as_str()? == "typescript").then_some(())?;
    manifest.get("version")?.as_str().map(str::to_owned)
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
