//! One server of the pool: its bridge, the languages routed to it, and what its definition pointed it at.
use std::sync::{Arc, Mutex};

use futures::FutureExt;
use indexmap::{IndexMap, IndexSet};
use serde_json::{Map, Value};

use super::bridge::{BridgeOptions, LspBridge};
use super::configuration::merge_settings;
use super::documents::ReadFn;
use super::locator::HasFn;
use super::process::{ProcessOptions, SettingsFuture};
use super::registry::{Lookup, ServerContext, ServerDefinition, definition_of};
use crate::protocol::{LanguageId, LspProcessStatus, LspProjects, LspServerStatus};
use crate::user_config::LspSettings;

/// The diff's files by language.
pub type PathsByLanguage = IndexMap<LanguageId, Vec<String>>;

/// The user's settings per language, laid over the built-in ones of the server owning it.
pub type UserSettings = Arc<LspSettings>;

pub struct ServerOptions {
    pub root: std::path::PathBuf,
    pub read: ReadFn,
    pub has: HasFn,
    pub lookup: Lookup,
    pub max_open: Option<usize>,
    pub settings: UserSettings,
    /// Its status moved.
    pub on_status: Arc<dyn Fn() + Send + Sync>,
}

/// The languages a server owns, answering first and alone for highlights and outlines, and the
/// ones it answers for beside their owner. Both grow as later snapshots resolve to it.
#[derive(Default, Clone)]
pub struct Routes {
    pub languages: Vec<LanguageId>,
    pub joins: Vec<LanguageId>,
}

pub struct PoolServer {
    pub command: String,
    pub bridge: LspBridge,
    pub routes: Mutex<Routes>,
    definition: ServerDefinition,
    user: UserSettings,
    root: std::path::PathBuf,
    lookup: Lookup,
    /// Every diff file it has answered for, so settings that follow them only grow.
    paths: Mutex<IndexSet<String>>,
    projects: Mutex<Option<LspProjects>>,
    on_status: Arc<dyn Fn() + Send + Sync>,
}

/// The built-in settings with the user's for `languages` laid over them, in that order; none when
/// neither has any, so a server nobody configured is sent nothing.
fn settings_of(
    definition: &ServerDefinition,
    ctx: &ServerContext,
    user: &UserSettings,
    languages: &[LanguageId],
) -> Option<SettingsFuture> {
    let builtin = definition.settings.map(|settings| settings(ctx));
    let layers: Vec<Value> = languages.iter().filter_map(|l| user.get(l)).map(|s| Value::Object(s.clone())).collect();
    if builtin.is_none() && layers.is_empty() {
        return None;
    }
    let settings = async move {
        let mut settings = match builtin {
            Some(builtin) => builtin.await,
            None => Value::Object(Map::new()),
        };
        for layer in &layers {
            merge_settings(&mut settings, layer);
        }
        settings
    };
    Some(settings.boxed().shared())
}

impl PoolServer {
    pub fn new(command: &str, routes: Routes, paths: &[String], opts: ServerOptions) -> Self {
        let definition = definition_of(command);
        let ctx = ServerContext { root: opts.root.clone(), paths: paths.to_vec(), lookup: opts.lookup.clone() };
        let projects = definition.projects.map(|projects| projects(&ctx));
        let notify = opts.on_status.clone();
        let process = ProcessOptions {
            command: command.to_owned(),
            root: opts.root.clone(),
            settings: settings_of(&definition, &ctx, &opts.settings, &routes.languages),
            initialization_options: definition.initialization_options.and_then(|init| init(&ctx)),
            on_status: Arc::new(move |_: &LspProcessStatus| notify()),
        };
        let bridge = LspBridge::new(BridgeOptions { process, read: opts.read, has: opts.has, max_open: opts.max_open });
        Self {
            command: command.to_owned(),
            bridge,
            routes: Mutex::new(routes),
            definition,
            user: opts.settings,
            root: opts.root,
            lookup: opts.lookup,
            paths: Mutex::new(paths.iter().cloned().collect()),
            projects: Mutex::new(projects),
            on_status: opts.on_status,
        }
    }

    pub fn routes(&self) -> Routes {
        self.routes.lock().unwrap().clone()
    }

    /// Routes `languages` and `joins` to it too. A newly owned language the user configured sends
    /// the server its settings again.
    pub fn route(&self, languages: &[LanguageId], joins: &[LanguageId]) {
        let mut configured = false;
        let owned = {
            let mut routes = self.routes.lock().unwrap();
            for &l in languages {
                if !routes.languages.contains(&l) {
                    routes.languages.push(l);
                    configured |= self.user.contains_key(&l);
                }
            }
            for &l in joins {
                if !routes.joins.contains(&l) {
                    routes.joins.push(l);
                }
            }
            routes.languages.clone()
        };
        if configured && let Some(settings) = settings_of(&self.definition, &self.context(), &self.user, &owned) {
            self.bridge.reconfigure(settings);
        }
    }

    fn context(&self) -> ServerContext {
        let paths = self.paths.lock().unwrap().iter().cloned().collect();
        ServerContext { root: self.root.clone(), paths, lookup: self.lookup.clone() }
    }

    pub fn status(&self) -> LspServerStatus {
        let p = self.bridge.status();
        let routes = self.routes();
        LspServerStatus {
            activity: p.activity,
            command: p.command,
            joins: routes.joins,
            languages: routes.languages,
            log: p.log,
            message: p.message,
            name: p.name,
            notice: p.notice,
            projects: self.projects.lock().unwrap().clone(),
            state: p.state,
            supports: self.bridge.features(),
        }
    }

    /// Takes in the diff's files for its languages. When they add one and its settings follow
    /// them, the server gets new settings, and the status moves if what it is pointed at did.
    pub fn follow(&self, paths: &[String]) {
        {
            let mut known = self.paths.lock().unwrap();
            let before = known.len();
            known.extend(paths.iter().cloned());
            if known.len() == before || !self.definition.reconfigures {
                return;
            }
        }
        let ctx = self.context();
        if let Some(settings) = settings_of(&self.definition, &ctx, &self.user, &self.routes().languages) {
            self.bridge.reconfigure(settings);
        }
        let now = self.definition.projects.map(|projects| projects(&ctx));
        let mut current = self.projects.lock().unwrap();
        if now == *current {
            return;
        }
        *current = now;
        drop(current);
        (self.on_status)();
    }
}

/// The diff's files for a server's languages, owned and joined.
pub fn paths_of(routes: &Routes, by_language: &PathsByLanguage) -> Vec<String> {
    routes.languages.iter().chain(&routes.joins).flat_map(|l| by_language.get(l).cloned().unwrap_or_default()).collect()
}
