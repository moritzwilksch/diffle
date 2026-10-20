//! One server of the pool: its bridge, the languages routed to it, and what its definition pointed it at.
use std::sync::{Arc, Mutex};

use futures::FutureExt;
use indexmap::{IndexMap, IndexSet};

use super::bridge::{BridgeOptions, LspBridge};
use super::documents::ReadFn;
use super::locator::HasFn;
use super::process::{ProcessOptions, SettingsFuture};
use super::registry::{Lookup, ServerContext, ServerDefinition, definition_of};
use crate::protocol::{LanguageId, LspProcessStatus, LspProjects, LspServerStatus};

/// The diff's files by language.
pub type PathsByLanguage = IndexMap<LanguageId, Vec<String>>;

pub struct ServerOptions {
    pub root: std::path::PathBuf,
    pub read: ReadFn,
    pub has: HasFn,
    pub lookup: Lookup,
    pub max_open: Option<usize>,
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
    root: std::path::PathBuf,
    lookup: Lookup,
    /// Every diff file it has answered for, so settings that follow them only grow.
    paths: Mutex<IndexSet<String>>,
    projects: Mutex<Option<LspProjects>>,
    on_status: Arc<dyn Fn() + Send + Sync>,
}

fn settings_of(definition: &ServerDefinition, ctx: &ServerContext) -> Option<SettingsFuture> {
    definition.settings.map(|settings| settings(ctx).shared())
}

impl PoolServer {
    pub fn new(command: &str, paths: &[String], opts: ServerOptions) -> Self {
        let definition = definition_of(command);
        let ctx = ServerContext { root: opts.root.clone(), paths: paths.to_vec(), lookup: opts.lookup.clone() };
        let projects = definition.projects.map(|projects| projects(&ctx));
        let notify = opts.on_status.clone();
        let process = ProcessOptions {
            command: command.to_owned(),
            root: opts.root.clone(),
            settings: settings_of(&definition, &ctx),
            initialization_options: definition.initialization_options.and_then(|init| init(&ctx)),
            on_status: Arc::new(move |_: &LspProcessStatus| notify()),
        };
        let bridge = LspBridge::new(BridgeOptions { process, read: opts.read, has: opts.has, max_open: opts.max_open });
        Self {
            command: command.to_owned(),
            bridge,
            routes: Mutex::default(),
            definition,
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
        let ctx = {
            let mut known = self.paths.lock().unwrap();
            let before = known.len();
            known.extend(paths.iter().cloned());
            if known.len() == before || !self.definition.reconfigures {
                return;
            }
            ServerContext {
                root: self.root.clone(),
                paths: known.iter().cloned().collect(),
                lookup: self.lookup.clone(),
            }
        };
        if let Some(settings) = settings_of(&self.definition, &ctx) {
            self.bridge.reconfigure(settings);
        }
        let now = self.definition.projects.map(|projects| projects(&ctx));
        let mut current = self.projects.lock().unwrap();
        if serde_json::to_value(&now).ok() == serde_json::to_value(&*current).ok() {
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
