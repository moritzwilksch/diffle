//! Which language server a file selects: by its extension, or as a Helm chart's template by where it
//! sits. The client keeps the same rule.
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

/// The file naming a Helm chart; its directory's `templates/` holds the chart's templates.
const CHART: &str = "Chart.yaml";
/// The extensions of a Helm template: manifests and the `_helpers.tpl` partials.
const TEMPLATE_EXTS: &[&str] = &["yaml", "yml", "tpl"];

/// The Helm charts on one new side: each directory holding a `Chart.yaml`, with its trailing `/`
/// (empty for the repository root).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Charts(BTreeSet<String>);

impl Charts {
    pub fn of(tree: &[String]) -> Self {
        let dirs = tree.iter().filter_map(|p| p.strip_suffix(CHART)).filter(|d| d.is_empty() || d.ends_with('/'));
        Self(dirs.map(str::to_owned).collect())
    }

    /// Whether `path` lies in a chart's `templates/`, at any depth. A subchart's own `templates/`
    /// counts too, as Helm renders it.
    fn holds_template(&self, path: &str) -> bool {
        path.match_indices("templates/").any(|(i, _)| self.0.contains(&path[..i]))
    }
}

/// Every language diffle can start a server for, sorted by its LSP spelling: `LANGUAGE_IDS`.
pub fn language_ids() -> Vec<LanguageId> {
    let by_ext = LANGUAGE_BY_EXT.iter().map(|(_, id)| *id);
    let ids: BTreeSet<(String, LanguageId)> = by_ext.chain([Helm]).map(|id| (id.to_string(), id)).collect();
    ids.into_iter().map(|(_, id)| id).collect()
}

/// The language of `path` on a new side holding `charts`: a chart's template is `helm`, anything
/// else goes by its extension, case-insensitively. None for an unknown or absent extension.
pub fn language_of(path: &str, charts: &Charts) -> Option<LanguageId> {
    let ext = path.rsplit(['.', '/', '\\']).next().filter(|ext| ext.len() < path.len())?;
    // The segment must follow a dot, not a separator: `dir/Makefile` has no extension.
    if !path[..path.len() - ext.len()].ends_with('.') || ext.is_empty() {
        return None;
    }
    let ext = ext.to_lowercase();
    if TEMPLATE_EXTS.contains(&ext.as_str()) && charts.holds_template(path) {
        return Some(Helm);
    }
    LANGUAGE_BY_EXT.iter().find(|(e, _)| *e == ext).map(|(_, id)| *id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn charts(tree: &[&str]) -> Charts {
        Charts::of(&tree.iter().map(|p| (*p).to_owned()).collect::<Vec<_>>())
    }

    #[test]
    fn reads_the_language_from_the_last_extension_case_insensitively() {
        let language_of = |path| language_of(path, &Charts::default());
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
    fn takes_a_template_for_helm_only_under_a_chart_on_the_same_side() {
        let side = charts(&[
            "deploy/app/Chart.yaml",
            "deploy/app/values.yaml",
            "deploy/app/templates/deployment.yaml",
            "deploy/app/charts/db/Chart.yaml",
            "Chart.yaml",
            "ci/templates/job.yml",
            "MyChart.yaml",
        ]);
        let of = |path| language_of(path, &side).map(|l| l.to_string());
        assert_eq!(of("deploy/app/templates/deployment.yaml").as_deref(), Some("helm"));
        assert_eq!(of("deploy/app/templates/_helpers.tpl").as_deref(), Some("helm"));
        assert_eq!(of("deploy/app/templates/tests/test-connection.YML").as_deref(), Some("helm"));
        assert_eq!(of("deploy/app/charts/db/templates/svc.yaml").as_deref(), Some("helm"));
        assert_eq!(of("templates/root.yaml").as_deref(), Some("helm"));
        // The chart's own files, other YAML, and a template outside any chart stay what they were.
        assert_eq!(of("deploy/app/values.yaml").as_deref(), Some("yaml"));
        assert_eq!(of("deploy/app/Chart.yaml").as_deref(), Some("yaml"));
        assert_eq!(of("deploy/app/templates/NOTES.txt"), None);
        assert_eq!(of("ci/templates/job.yml").as_deref(), Some("yaml"));
        assert_eq!(of("ci/templates/macro.tpl"), None);
        assert_eq!(of("deploy/app/my-templates/x.yaml").as_deref(), Some("yaml"));
        // Without a `Chart.yaml` on this side, the same path is plain YAML.
        assert_eq!(language_of("deploy/app/templates/deployment.yaml", &Charts::default()), Some(Yaml));
    }
}
