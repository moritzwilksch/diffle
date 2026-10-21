//! What a language server is pointed at: Cargo workspaces, a TypeScript, the Vue plugin.
pub mod cargo;
pub mod catalog;
pub mod shown;
pub mod tsdk;
pub mod vue;

use std::path::{Path, PathBuf};

/// Where `package` (`name` or `@scope/name`) resolves from `base`, as Node's `createRequire(base)`
/// finds it: `node_modules/<package>/package.json` in `base` and each ancestor not itself named
/// `node_modules`, the first hit's directory with symlinks resolved. Unlike Node, the package's
/// `main` is not checked and `NODE_PATH` and global folders are not searched: every caller only
/// needs the package directory.
pub fn resolve_package(base: &Path, package: &str) -> Option<PathBuf> {
    base.ancestors()
        .filter(|dir| dir.file_name().is_none_or(|name| name != "node_modules"))
        .map(|dir| dir.join("node_modules").join(package))
        .find(|dir| dir.join("package.json").is_file())
        .map(|dir| dunce::canonicalize(&dir).unwrap_or(dir))
}
