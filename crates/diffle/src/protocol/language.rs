//! Which language server a file's name or extension selects; the client keeps the same tables.
use std::collections::BTreeSet;

use super::LanguageId::{self, *};

const LANGUAGE_BY_EXT: &[(&str, LanguageId)] = &[
    ("astro", Astro),
    ("bash", Shellscript),
    ("c", C),
    ("cc", Cpp),
    ("cjs", Javascript),
    ("cpp", Cpp),
    ("cs", Csharp),
    ("css", Css),
    ("cts", Typescript),
    ("cxx", Cpp),
    ("dockerfile", Dockerfile),
    ("go", Go),
    ("h", C),
    ("hh", Cpp),
    ("hpp", Cpp),
    ("hs", Haskell),
    ("htm", Html),
    ("html", Html),
    ("hxx", Cpp),
    ("java", Java),
    ("js", Javascript),
    ("jsx", Javascriptreact),
    ("json", Json),
    ("jsonc", Jsonc),
    ("lua", Lua),
    ("mjs", Javascript),
    ("ml", Ocaml),
    ("mli", Ocaml),
    ("mts", Typescript),
    ("nix", Nix),
    ("php", Php),
    ("py", Python),
    ("pyi", Python),
    ("rb", Ruby),
    ("rs", Rust),
    ("sh", Shellscript),
    ("swift", Swift),
    ("tf", Terraform),
    ("tfvars", Terraform),
    ("toml", Toml),
    ("ts", Typescript),
    ("tsx", Typescriptreact),
    ("vue", Vue),
    ("yaml", Yaml),
    ("yml", Yaml),
    ("zig", Zig),
];

/// File name (lowercase) → language, for files named rather than extended. A name also claims
/// `<name>.<suffix>` (`Dockerfile.dev`), ahead of the suffix as an extension.
const LANGUAGE_BY_NAME: &[(&str, LanguageId)] = &[("containerfile", Dockerfile), ("dockerfile", Dockerfile)];

/// Every language some name or extension selects, sorted by its LSP spelling: `LANGUAGE_IDS`.
pub fn language_ids() -> Vec<LanguageId> {
    let ids: BTreeSet<(String, LanguageId)> =
        LANGUAGE_BY_EXT.iter().chain(LANGUAGE_BY_NAME).map(|(_, id)| (id.to_string(), *id)).collect();
    ids.into_iter().map(|(_, id)| id).collect()
}

/// The language of `path` by its file name, then its extension, case-insensitively; none for an
/// unknown or absent one.
pub fn language_of(path: &str) -> Option<LanguageId> {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path).to_lowercase();
    let stem = name.split('.').next().unwrap_or_default();
    if let Some((_, id)) = LANGUAGE_BY_NAME.iter().find(|(n, _)| *n == stem) {
        return Some(*id);
    }
    // The extension must follow a dot in the name: `dir.py/Makefile` has none.
    let (_, ext) = name.rsplit_once('.')?;
    LANGUAGE_BY_EXT.iter().find(|(e, _)| *e == ext).map(|(_, id)| *id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_language_from_the_last_extension_case_insensitively() {
        assert_eq!(language_of("src/main.rs"), Some(Rust));
        assert_eq!(language_of("App.TSX"), Some(Typescriptreact));
        assert_eq!(language_of("a.d.ts"), Some(Typescript));
        assert_eq!(language_of("Makefile"), None);
        assert_eq!(language_of("dir.py/Makefile"), None);
        assert_eq!(language_of("trailing."), None);
        assert_eq!(language_of("x.unknown"), None);
        assert_eq!(language_of(".bashrc"), None);
    }

    #[test]
    fn reads_dockerfiles_by_name_before_extension() {
        for path in [
            "Dockerfile",
            "container/Dockerfile",
            "Containerfile",
            "Dockerfile.dev",
            "DOCKERFILE.prod.json",
            "api.dockerfile",
            r"c:\x\dockerfile",
        ] {
            assert_eq!(language_of(path), Some(Dockerfile), "{path}");
        }
        for path in ["Dockerfiles/app.py", "my-Dockerfile", ".dockerignore", "Dockerfile/README"] {
            assert_ne!(language_of(path), Some(Dockerfile), "{path}");
        }
    }

    #[test]
    fn lists_each_language_once_in_spelling_order() {
        let ids: Vec<String> = language_ids().iter().map(ToString::to_string).collect();
        let mut sorted = ids.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(ids, sorted);
        assert!(ids.contains(&"shellscript".to_owned()) && ids.len() == 30);
    }
}
