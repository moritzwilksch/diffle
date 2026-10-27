//! Every report generator diffle knows, and which to run: the built-in rows, replaced or turned off
//! by name in the user config, plus the config's own.
use regex::Regex;
use std::collections::HashMap;

use crate::lsp::registry::Lookup;
use crate::lsp::which::argv0;
use crate::protocol::{ChangedFile, PluginConfig, PluginConfigScope};

/// Which files of a snapshot a generator gets copies of.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    /// The changed files its globs matched, with a rename's old name on the old side.
    Changed,
    /// Every file the snapshot shows, so a document's imports resolve.
    Tree,
}

/// One generator to run: its report's id is `name`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plugin {
    pub name: String,
    pub command: String,
    pub when: Vec<String>,
    pub scope: Scope,
    /// Where it came from, for `diffle plugins`.
    pub configured: bool,
}

/// A built-in generator whose programs are not on PATH.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Missing {
    pub name: String,
    pub command: String,
    /// The programs looked for, so the UI can name what to install.
    pub tried: Vec<String>,
}

pub struct Resolution {
    pub plugins: Vec<Plugin>,
    pub missing: Vec<Missing>,
}

struct Builtin {
    name: &'static str,
    command: &'static str,
    when: &'static [&'static str],
    scope: Scope,
}

/// The generators diffle starts on its own when their programs are on PATH.
const BUILTINS: &[Builtin] = &[
    Builtin {
        name: "pixi",
        command: "pixi-diff --before $DIFFLE_OLD/$DIFFLE_FILE --after $DIFFLE_NEW/$DIFFLE_FILE | pixi-diff-to-markdown",
        when: &["pixi.lock"],
        scope: Scope::Changed,
    },
    Builtin { name: "typst", command: "diffle-typst", when: &["*.typ"], scope: Scope::Tree },
];

/// The built-in rows, as `diffle plugins` lists them.
pub fn builtins() -> Vec<Plugin> {
    BUILTINS
        .iter()
        .map(|b| plugin(b.name, b.command, b.when.iter().map(|w| (*w).to_owned()).collect(), b.scope, false))
        .collect()
}

fn plugin(name: &str, command: &str, when: Vec<String>, scope: Scope, configured: bool) -> Plugin {
    Plugin { name: name.to_owned(), command: command.trim().to_owned(), when, scope, configured }
}

/// The programs a command line runs: the first word of each `|`-separated stage.
pub fn programs_of(command: &str) -> Vec<String> {
    command.split('|').map(|stage| argv0(stage.trim())).filter(|p| !p.is_empty()).collect()
}

/// Which generators to run. A config entry named like a built-in replaces it, and one with an
/// empty command turns it off; a built-in is never run while a program of its is off PATH, and is
/// listed as missing instead. Configured commands are not probed: the user named them, so a typo
/// surfaces as a failed report, not as silence.
pub fn resolve(config: &HashMap<String, PluginConfig>, lookup: &Lookup) -> Resolution {
    let mut plugins = Vec::new();
    let mut missing = Vec::new();
    for b in BUILTINS {
        let Some(entry) = config.get(b.name) else {
            let tried: Vec<String> = programs_of(b.command).into_iter().filter(|p| lookup(p).is_none()).collect();
            if tried.is_empty() {
                plugins.push(plugin(
                    b.name,
                    b.command,
                    b.when.iter().map(|w| (*w).to_owned()).collect(),
                    b.scope,
                    false,
                ));
            } else {
                missing.push(Missing { name: b.name.to_owned(), command: b.command.to_owned(), tried });
            }
            continue;
        };
        if entry.command.trim().is_empty() {
            continue;
        }
        let when =
            if entry.when.is_empty() { b.when.iter().map(|w| (*w).to_owned()).collect() } else { entry.when.clone() };
        plugins.push(plugin(b.name, &entry.command, when, scope_of(entry).unwrap_or(b.scope), true));
    }
    let mut named: Vec<(&String, &PluginConfig)> =
        config.iter().filter(|(name, _)| !BUILTINS.iter().any(|b| b.name == name.as_str())).collect();
    named.sort_by(|a, b| a.0.cmp(b.0));
    for (name, entry) in named {
        if entry.command.trim().is_empty() || entry.when.is_empty() {
            continue;
        }
        plugins.push(plugin(name, &entry.command, entry.when.clone(), scope_of(entry).unwrap_or(Scope::Changed), true));
    }
    Resolution { plugins, missing }
}

fn scope_of(entry: &PluginConfig) -> Option<Scope> {
    entry.scope.map(|s| match s {
        PluginConfigScope::Changed => Scope::Changed,
        PluginConfigScope::Tree => Scope::Tree,
    })
}

/// The changed files `plugin` runs for: those a glob of its matches, by new path.
pub fn matched(plugin: &Plugin, changed: &[ChangedFile]) -> Vec<String> {
    let globs: Vec<Glob> = plugin.when.iter().map(|g| Glob::new(g)).collect();
    changed.iter().filter(|f| globs.iter().any(|g| g.is_match(&f.path))).map(|f| f.path.clone()).collect()
}

/// A picomatch-style glob: `*` and `?` stay within one path segment, `**` spans any number. A
/// pattern without a slash matches the file's name in any folder, as a gitignore line does.
pub struct Glob {
    regex: Regex,
    basename: bool,
}

impl Glob {
    pub fn new(pattern: &str) -> Self {
        let pattern = pattern.trim().trim_start_matches("./");
        let basename = !pattern.contains('/');
        let mut re = String::from("^");
        let mut chars = pattern.chars().peekable();
        while let Some(c) = chars.next() {
            match c {
                '*' if chars.peek() == Some(&'*') => {
                    chars.next();
                    // `**/` also matches no folder at all.
                    if chars.peek() == Some(&'/') {
                        chars.next();
                        re.push_str("(?:.*/)?");
                    } else {
                        re.push_str(".*");
                    }
                }
                '*' => re.push_str("[^/]*"),
                '?' => re.push_str("[^/]"),
                other => re.push_str(&regex::escape(&other.to_string())),
            }
        }
        re.push('$');
        Self { regex: Regex::new(&re).expect("escaped glob"), basename }
    }

    pub fn is_match(&self, path: &str) -> bool {
        let subject = if self.basename { path.rsplit('/').next().unwrap_or(path) } else { path };
        self.regex.is_match(subject)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::Arc;

    #[test]
    fn globs_follow_picomatch_within_segments() {
        assert!(Glob::new("pixi.lock").is_match("apps/web/pixi.lock"));
        assert!(Glob::new("*.typ").is_match("thesis/chapters/intro.typ"));
        assert!(!Glob::new("*.typ").is_match("thesis/intro.typst"));
        assert!(Glob::new("docs/**/*.md").is_match("docs/a/b/c.md"));
        assert!(Glob::new("docs/**/*.md").is_match("docs/c.md"));
        assert!(!Glob::new("docs/*.md").is_match("docs/a/c.md"));
        assert!(Glob::new("src/?.rs").is_match("src/a.rs"));
        assert!(!Glob::new("src/?.rs").is_match("src/ab.rs"));
        assert!(Glob::new("**/pixi.lock").is_match("pixi.lock"));
    }

    fn lookup(present: &'static [&'static str]) -> Lookup {
        Arc::new(move |p: &str| present.contains(&p).then(|| PathBuf::from(p)))
    }

    #[test]
    fn resolves_builtins_against_path_and_config() {
        let r = resolve(&HashMap::new(), &lookup(&["pixi-diff", "pixi-diff-to-markdown"]));
        assert_eq!(r.plugins.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["pixi"]);
        assert_eq!(
            r.missing,
            [Missing { name: "typst".into(), command: "diffle-typst".into(), tried: vec!["diffle-typst".into()] }]
        );

        let config = HashMap::from([
            ("pixi".to_owned(), PluginConfig { command: String::new(), when: vec![], scope: None }),
            ("typst".to_owned(), PluginConfig { command: "my-typst --fast".into(), when: vec![], scope: None }),
            (
                "notes".to_owned(),
                PluginConfig {
                    command: "notes".into(),
                    when: vec!["*.md".into()],
                    scope: Some(PluginConfigScope::Tree),
                },
            ),
            ("nowhen".to_owned(), PluginConfig { command: "x".into(), when: vec![], scope: None }),
        ]);
        let r = resolve(&config, &lookup(&[]));
        assert!(r.missing.is_empty());
        let names: Vec<(&str, &str, Scope, bool)> =
            r.plugins.iter().map(|p| (p.name.as_str(), p.command.as_str(), p.scope, p.configured)).collect();
        assert_eq!(names, [("typst", "my-typst --fast", Scope::Tree, true), ("notes", "notes", Scope::Tree, true)]);
        assert_eq!(r.plugins[0].when, ["*.typ"]);
    }

    #[test]
    fn matched_files_follow_the_globs() {
        let plugin = plugin("p", "p", vec!["pixi.lock".into()], Scope::Changed, false);
        let file = |path: &str| ChangedFile {
            path: path.into(),
            old_path: None,
            status: crate::protocol::ChangeStatus::M,
            additions: 0,
            deletions: 0,
            binary: false,
            blob: String::new(),
            old_blob: String::new(),
            generated: false,
            submodule: None,
        };
        assert_eq!(matched(&plugin, &[file("a/pixi.lock"), file("pixi.toml")]), ["a/pixi.lock"]);
    }
}
