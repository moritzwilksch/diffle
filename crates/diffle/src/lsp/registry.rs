//! Every language server diffle knows: how each is started and configured, and which to start.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use futures::future::BoxFuture;
use serde_json::Value;

use super::projects::catalog::{Candidate, candidates};
use super::which::{argv0, find_on_path, program_of};
use crate::protocol::LanguageId;
use crate::protocol::{LspMissing, LspProjects};

/// The PATH probe: where a command line's program lives. A test seam.
pub type Lookup = Arc<dyn Fn(&str) -> Option<PathBuf> + Send + Sync>;

pub fn default_lookup() -> Lookup {
    Arc::new(find_on_path)
}

/// What a server's settings may depend on.
#[derive(Clone)]
pub struct ServerContext {
    /// Repository root: the workspace folder.
    pub root: PathBuf,
    /// The diff's files the server answers for, repository-relative: where its projects sit.
    pub paths: Vec<String>,
    pub lookup: Lookup,
}

/// Settings sent after initialization and answered to `workspace/configuration`.
pub type SettingsFn = fn(&ServerContext) -> BoxFuture<'static, Value>;

/// How one language server is started and configured: everything diffle knows about it.
#[derive(Clone)]
pub struct ServerDefinition {
    /// The command line that starts it on stdio: a program on PATH and its arguments, split as a shell would.
    pub command: String,
    pub settings: Option<SettingsFn>,
    /// Sent with `initialize`, for servers configured there rather than through settings.
    pub initialization_options: Option<fn(&ServerContext) -> Option<Value>>,
    /// What it is pointed at, for the status; recomputed with `settings`.
    pub projects: Option<fn(&ServerContext) -> LspProjects>,
    /// Whether `settings` reads `paths`: recomputed and sent again when a later snapshot adds one.
    pub reconfigures: bool,
}

/// One process to start: its command and every language routed to it.
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedServer {
    pub command: String,
    /// Languages it owns: it answers first and alone for highlights, tokens and outlines.
    pub languages: Vec<LanguageId>,
    /// Languages it answers for beside their owner.
    pub joins: Vec<LanguageId>,
}

pub struct Resolution {
    pub servers: Vec<ResolvedServer>,
    /// Languages nothing on PATH can serve. A language turned off by config is absent from both lists.
    pub missing: Vec<LspMissing>,
}

/// The candidate commands for a language, in the order they are tried.
pub fn candidates_for(language: LanguageId) -> Vec<String> {
    candidates().filter(|c| c.languages.contains(&language)).map(|c| c.command.to_owned()).collect()
}

/// How a command line's program is configured, by the built-in definition for that program: an
/// override naming a known server with other flags or a full path still gets its settings. A
/// program diffle does not know takes none.
pub fn definition_of(command: &str) -> ServerDefinition {
    let program = program_of(command);
    let known = candidates().find(|c| program_of(c.command) == program);
    ServerDefinition {
        command: command.to_owned(),
        settings: known.and_then(|c| c.settings),
        initialization_options: known.and_then(|c| c.initialization_options),
        projects: known.and_then(|c| c.projects),
        reconfigures: known.is_some_and(|c| c.reconfigures),
    }
}

/// The spec's spelling of a language, which is also how languages sort.
fn name(language: LanguageId) -> String {
    serde_json::to_value(language).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default()
}

/// Which servers to start for `languages`. A config override replaces the candidate list for its
/// language and is never probed: the user named a command, so a typo should surface as the server
/// failing to start, not as silence. An override of `""` turns the language off. Languages
/// resolving to the same command line share one process. A missing language's `tried` names the
/// programs that were not on PATH; a program on PATH lacking what the candidate loads from beside
/// it is as good as absent, and the first such finding is the language's `why`. A candidate joining
/// a requested language starts too, when on PATH, and joins only the requested ones.
pub fn resolve_servers(
    languages: impl IntoIterator<Item = LanguageId>,
    overrides: &HashMap<LanguageId, String>,
    lookup: &Lookup,
) -> Resolution {
    let mut probed: HashMap<String, Option<PathBuf>> = HashMap::new();
    let mut where_is = |command: &str| -> Option<PathBuf> {
        probed.entry(command.to_owned()).or_insert_with(|| lookup(command)).clone()
    };
    // What keeps a candidate from starting: programs not on PATH, or one without what it loads beside it.
    let mut probe = |c: &Candidate| -> (Vec<String>, Option<String>) {
        let mut absent = Vec::new();
        if where_is(c.command).is_none() {
            absent.push(argv0(c.command));
        }
        let Some(requires) = &c.requires else { return (absent, None) };
        match where_is(requires.program) {
            None => absent.push(requires.program.to_owned()),
            Some(executable) if (requires.locate)(&executable).is_none() => {
                return (
                    absent,
                    Some(format!("{} is on PATH but {} was not found beside it", requires.program, requires.what)),
                );
            }
            Some(_) => {}
        }
        (absent, None)
    };
    let mut servers: Vec<ResolvedServer> = Vec::new();
    let mut missing = Vec::new();
    // Sorted so the status, the startup line and `diffle lsp` list servers the same way every run.
    let mut asked: Vec<LanguageId> = languages.into_iter().collect();
    asked.sort_by_key(|l| name(*l));
    asked.dedup();
    for &language in &asked {
        let mut command = overrides.get(&language).map(|c| c.trim().to_owned());
        let (mut tried, mut why) = (Vec::<String>::new(), None);
        if command.is_none() {
            for c in candidates().filter(|c| c.languages.contains(&language)) {
                let (absent, broken) = probe(c);
                if absent.is_empty() && broken.is_none() {
                    command = Some(c.command.to_owned());
                    break;
                }
                why = why.or(broken);
                for program in absent {
                    if !tried.contains(&program) {
                        tried.push(program);
                    }
                }
            }
        }
        // An empty override is a deliberate off switch, and names nothing to install.
        let Some(command) = command.filter(|c| !c.is_empty()) else {
            missing.push(LspMissing { language, tried, why });
            continue;
        };
        match servers.iter_mut().find(|s| s.command == command) {
            Some(server) => server.languages.push(language),
            None => servers.push(ResolvedServer { command, languages: vec![language], joins: Vec::new() }),
        }
    }
    for c in candidates() {
        let joins: Vec<LanguageId> = c.joins.iter().copied().filter(|l| asked.contains(l)).collect();
        if joins.is_empty() {
            continue;
        }
        let (absent, broken) = probe(c);
        if !absent.is_empty() || broken.is_some() {
            continue;
        }
        let index = servers.iter().position(|s| s.command == c.command).unwrap_or_else(|| {
            servers.push(ResolvedServer { command: c.command.to_owned(), languages: Vec::new(), joins: Vec::new() });
            servers.len() - 1
        });
        let server = &mut servers[index];
        for l in joins {
            if !server.languages.contains(&l) && !server.joins.contains(&l) {
                server.joins.push(l);
            }
        }
    }
    Resolution { servers, missing }
}
