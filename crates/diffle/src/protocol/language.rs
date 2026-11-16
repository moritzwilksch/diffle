//! Which language server a file selects: by its extension, or as a Helm template by its directory.
//! The client keeps the same rule.
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

/// The extensions of a Helm template: manifests and the `_helpers.tpl` partials.
const TEMPLATE_EXTS: &[&str] = &["yaml", "yml", "tpl"];

/// Every language diffle can start a server for, sorted by its LSP spelling: `LANGUAGE_IDS`.
pub fn language_ids() -> Vec<LanguageId> {
    let by_ext = LANGUAGE_BY_EXT.iter().map(|(_, id)| *id);
    let ids: BTreeSet<(String, LanguageId)> = by_ext.chain([Helm]).map(|id| (id.to_string(), id)).collect();
    ids.into_iter().map(|(_, id)| id).collect()
}

/// The language of `path`: a YAML or `.tpl` file under a `templates/` directory is `helm`, as in a
/// chart; anything else goes by its extension, case-insensitively. None for an unknown or absent
/// extension. Any `templates/` counts, chart or not: telling them apart needs the tree around the path.
pub fn language_of(path: &str) -> Option<LanguageId> {
    let ext = path.rsplit(['.', '/', '\\']).next().filter(|ext| ext.len() < path.len())?;
    // The segment must follow a dot, not a separator: `dir/Makefile` has no extension.
    if !path[..path.len() - ext.len()].ends_with('.') || ext.is_empty() {
        return None;
    }
    let ext = ext.to_lowercase();
    if TEMPLATE_EXTS.contains(&ext.as_str()) && in_templates(path) {
        return Some(Helm);
    }
    LANGUAGE_BY_EXT.iter().find(|(e, _)| *e == ext).map(|(_, id)| *id)
}

/// Whether a directory of `path` is named `templates`: at the start or after a separator.
fn in_templates(path: &str) -> bool {
    path.match_indices("templates/").any(|(i, _)| i == 0 || path[..i].ends_with('/'))
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
        assert!(ids.contains(&"shellscript".to_owned()) && ids.contains(&"helm".to_owned()) && ids.len() == 30);
    }

    #[test]
    fn takes_a_yaml_or_tpl_file_under_a_templates_directory_for_helm() {
        let of = |path| language_of(path).map(|l| l.to_string());
        for helm in [
            "deploy/app/templates/deployment.yaml",
            "deploy/app/templates/_helpers.tpl",
            "deploy/app/templates/tests/x.yml",
            "deploy/app/charts/db/templates/svc.yaml",
            "templates/root.YAML",
            // The tradeoff of a rule on the path alone: a templates directory outside any chart counts too.
            "ci/templates/job.yml",
        ] {
            assert_eq!(of(helm).as_deref(), Some("helm"), "{helm}");
        }
        assert_eq!(of("deploy/app/values.yaml").as_deref(), Some("yaml"));
        assert_eq!(of("deploy/app/Chart.yaml").as_deref(), Some("yaml"));
        assert_eq!(of("deploy/app/my-templates/x.yaml").as_deref(), Some("yaml"));
        assert_eq!(of("deploy/app/templates/NOTES.txt"), None);
        assert_eq!(of("deploy/app/templates/config.json").as_deref(), Some("json"));
    }
}
