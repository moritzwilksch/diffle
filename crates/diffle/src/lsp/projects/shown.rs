//! How a project path reads in the status.
use std::path::{Component, Path, PathBuf};

/// Repository-relative inside the repository, else `~`-abbreviated in the home directory, else as is.
pub fn shown_path(root: &Path, path: &Path) -> String {
    let path = normalize(path);
    if let Some(rel) = within(&normalize(root), &path) {
        return if rel.is_empty() { ".".into() } else { rel };
    }
    if let Some(home) = std::env::home_dir()
        && let Some(rel) = within(&normalize(&home), &path)
    {
        return if rel.is_empty() { "~".into() } else { format!("~/{rel}") };
    }
    path.to_string_lossy().into_owned()
}

/// `path` relative to `dir` with forward slashes, or none when it is not inside it.
fn within(dir: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(dir).ok()?;
    Some(rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/"))
}

/// `.` and `..` folded away, as Node's `path.join` and `path.relative` see a path.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_repository_relative_then_home_abbreviated_then_absolute() {
        let home = std::env::home_dir().unwrap();
        let root = home.join("src").join("app");
        assert_eq!(
            shown_path(&root, &root.join("frontend").join("node_modules").join("typescript")),
            "frontend/node_modules/typescript"
        );
        assert_eq!(shown_path(&root, &root), ".");
        // A sibling whose name starts with dots is outside, not a parent.
        assert_eq!(shown_path(&root, &root.join("..").join("app..x")), "~/src/app..x");
        assert_eq!(
            shown_path(&root, &home.join(".local/lib/node_modules/typescript")),
            "~/.local/lib/node_modules/typescript"
        );
        let elsewhere = home.join("..").join("opt-elsewhere").join("typescript");
        assert_eq!(shown_path(&root, &elsewhere), normalize(&elsewhere).to_string_lossy());
    }
}
