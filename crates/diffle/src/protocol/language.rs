//! Which language server a file selects: by its name or extension, or as a Helm template by its
//! place in a chart. The client keeps the same rules.
use std::collections::BTreeSet;

use super::LanguageId::{self, *};

const LANGUAGE_BY_EXT: &[(&str, LanguageId)] = &[
    ("astro", Astro),
    ("bash", Shellscript),
    ("c", C),
    ("cc", Cpp),
    ("cjs", Javascript),
    ("containerfile", Dockerfile),
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

/// The extensions of a Helm template: manifests and the `_helpers.tpl` partials.
const TEMPLATE_EXTS: &[&str] = &["yaml", "yml", "tpl"];

/// File name (lowercase) → language, for files named rather than extended. A name also claims
/// `<name>.<suffix>` (`Dockerfile.dev`), ahead of the suffix as an extension.
const LANGUAGE_BY_NAME: &[(&str, LanguageId)] = &[("containerfile", Dockerfile), ("dockerfile", Dockerfile)];

/// Suffixes that turn a named file into something else: BuildKit's `Dockerfile.dockerignore`.
const NOT_BY_NAME: &[&str] = &["dockerignore"];

/// Every language diffle can start a server for, sorted by its LSP spelling: `LANGUAGE_IDS`.
pub fn language_ids() -> Vec<LanguageId> {
    let named = LANGUAGE_BY_EXT.iter().chain(LANGUAGE_BY_NAME).map(|(_, id)| *id);
    let ids: BTreeSet<(String, LanguageId)> = named.chain([Helm]).map(|id| (id.to_string(), id)).collect();
    ids.into_iter().map(|(_, id)| id).collect()
}

/// The language of `path` in `tree`, the sorted paths of the side it lies on: a YAML or `.tpl`
/// file under a chart's `templates/`, beside its `Chart.yaml`, is `helm`; anything else goes by its
/// file name, then its extension, case-insensitively. None for an unknown or absent one.
pub fn language_of(path: &str, tree: &[String]) -> Option<LanguageId> {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path).to_lowercase();
    let stem = name.split('.').next().unwrap_or_default();
    // The extension must follow a dot in the name: `dir.py/Makefile` has none.
    let ext = name.rsplit_once('.').map(|(_, ext)| ext);
    if !ext.is_some_and(|ext| NOT_BY_NAME.contains(&ext))
        && let Some((_, id)) = LANGUAGE_BY_NAME.iter().find(|(n, _)| *n == stem)
    {
        return Some(*id);
    }
    let ext = ext?;
    if TEMPLATE_EXTS.contains(&ext) && in_chart_templates(path, tree) {
        return Some(Helm);
    }
    LANGUAGE_BY_EXT.iter().find(|(e, _)| *e == ext).map(|(_, id)| *id)
}

/// Whether a directory of `path` named `templates` has a `Chart.yaml` beside it in `tree`.
fn in_chart_templates(path: &str, tree: &[String]) -> bool {
    path.match_indices("templates/").filter(|(i, _)| *i == 0 || path[..*i].ends_with('/')).any(|(i, _)| {
        let chart = format!("{}Chart.yaml", &path[..i]);
        tree.binary_search_by(|p| p.as_str().cmp(&chart)).is_ok()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_language_from_the_last_extension_case_insensitively() {
        assert_eq!(language_of("src/main.rs", &[]), Some(Rust));
        assert_eq!(language_of("App.TSX", &[]), Some(Typescriptreact));
        assert_eq!(language_of("a.d.ts", &[]), Some(Typescript));
        assert_eq!(language_of("Makefile", &[]), None);
        assert_eq!(language_of("dir.py/Makefile", &[]), None);
        assert_eq!(language_of("trailing.", &[]), None);
        assert_eq!(language_of("x.unknown", &[]), None);
        assert_eq!(language_of(".bashrc", &[]), None);
    }

    #[test]
    fn reads_dockerfiles_by_name_before_extension() {
        for path in [
            "Dockerfile",
            "container/Dockerfile",
            "Containerfile",
            "Dockerfile.dev",
            "api.dockerfile",
            "api.containerfile",
            r"c:\x\dockerfile",
        ] {
            assert_eq!(language_of(path, &[]), Some(Dockerfile), "{path}");
        }
        for path in [
            "Dockerfiles/app.py",
            "my-Dockerfile",
            ".dockerignore",
            "Dockerfile.dockerignore",
            "Dockerfile.dev.dockerignore",
            "Dockerfile/README",
        ] {
            assert_ne!(language_of(path, &[]), Some(Dockerfile), "{path}");
        }
    }

    #[test]
    fn lists_each_language_once_in_spelling_order() {
        let ids: Vec<String> = language_ids().iter().map(ToString::to_string).collect();
        let mut sorted = ids.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(ids, sorted);
        assert!(ids.contains(&"shellscript".to_owned()) && ids.contains(&"helm".to_owned()) && ids.len() == 31);
    }

    #[test]
    fn takes_a_yaml_or_tpl_file_under_a_charts_templates_for_helm() {
        let tree: Vec<String> = ["Chart.yaml", "deploy/app/Chart.yaml", "deploy/app/charts/db/Chart.yaml"]
            .map(String::from)
            .into_iter()
            .collect();
        let of = |path| language_of(path, &tree).map(|l| l.to_string());
        for helm in [
            "deploy/app/templates/deployment.yaml",
            "deploy/app/templates/_helpers.tpl",
            "deploy/app/templates/tests/x.yml",
            "deploy/app/charts/db/templates/svc.yaml",
            "templates/root.YAML",
        ] {
            assert_eq!(of(helm).as_deref(), Some("helm"), "{helm}");
        }
        assert_eq!(of("deploy/app/values.yaml").as_deref(), Some("yaml"));
        assert_eq!(of("deploy/app/Chart.yaml").as_deref(), Some("yaml"));
        assert_eq!(of("deploy/app/my-templates/x.yaml").as_deref(), Some("yaml"));
        // No Chart.yaml beside the templates directory: plain YAML, as in a CI repository.
        assert_eq!(of("ci/templates/job.yml").as_deref(), Some("yaml"));
        assert_eq!(of("deploy/app/sub/templates/x.yaml").as_deref(), Some("yaml"));
        assert_eq!(of("deploy/app/templates/NOTES.txt"), None);
        assert_eq!(of("deploy/app/templates/config.json").as_deref(), Some("json"));
    }
}
