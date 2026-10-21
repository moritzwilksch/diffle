//! Which language server a file's extension selects; the client keeps the same table.
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

/// Every language some extension selects, sorted by its LSP spelling: `LANGUAGE_IDS`.
pub fn language_ids() -> Vec<LanguageId> {
    let ids: BTreeSet<(String, LanguageId)> = LANGUAGE_BY_EXT.iter().map(|(_, id)| (id.to_string(), *id)).collect();
    ids.into_iter().map(|(_, id)| id).collect()
}

/// The language of `path` by its extension, case-insensitively; none for an unknown or absent one.
pub fn language_of(path: &str) -> Option<LanguageId> {
    let ext = path.rsplit(['.', '/', '\\']).next().filter(|ext| ext.len() < path.len())?;
    // The segment must follow a dot, not a separator: `dir/Makefile` has no extension.
    if !path[..path.len() - ext.len()].ends_with('.') || ext.is_empty() {
        return None;
    }
    let ext = ext.to_lowercase();
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
    fn lists_each_language_once_in_spelling_order() {
        let ids: Vec<String> = language_ids().iter().map(ToString::to_string).collect();
        let mut sorted = ids.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(ids, sorted);
        assert!(ids.contains(&"shellscript".to_owned()) && ids.len() == 29);
    }
}
