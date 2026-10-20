//! The run's language servers: started from the config and `--lsp`, reported on stderr, and listed by `diffle lsp`.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures::FutureExt;

use super::paint::{dim, red, yellow};
use crate::lsp::pool::{LspPool, PoolOptions};
use crate::lsp::registry::{default_lookup, resolve_servers};
use crate::protocol::{
    LanguageId, LspState, ServerMessage, Side, Snapshot, language_ids, languages_label, readable_by_servers,
};
use crate::server::hub::Hub;
use crate::session::{Broadcaster, Session};
use crate::user_config::UserConfigStore;

/// The pool reads new-side text through the session, so the snapshot allowlist applies to every
/// LSP path. Each snapshot decides which languages run and which files the servers hold open.
pub fn start(
    session: &Arc<Session>,
    hub: &Arc<Hub>,
    overrides: HashMap<LanguageId, String>,
    preload: Vec<LanguageId>,
) -> Arc<LspPool> {
    let (reader, checker) = (Arc::downgrade(session), Arc::downgrade(session));
    // Progress repeats the full status; each changed warning or error is printed once.
    let reported: Mutex<HashMap<String, String>> = Mutex::default();
    let broadcast = hub.clone();
    let pool = LspPool::new(PoolOptions {
        root: session.repo.root.clone(),
        read: Arc::new(move |path| {
            let session = reader.clone();
            async move {
                let session = session.upgrade()?;
                let snap = session.snapshotter().ok()?.current().await.ok()?;
                let buf = session.read_side(&snap, &path, Side::New).await.ok()??;
                Some(String::from_utf8_lossy(&buf).into_owned())
            }
            .boxed()
        }),
        has: Arc::new(move |path| {
            let session = checker.clone();
            async move {
                let Some(session) = session.upgrade() else { return false };
                let Ok(snapshotter) = session.snapshotter() else { return false };
                let Ok(snap) = snapshotter.current().await else { return false };
                session.has_side(&snap, &path, Side::New)
            }
            .boxed()
        }),
        on_status: Arc::new(move |status| {
            let mut reported = reported.lock().unwrap();
            for s in &status.servers {
                let message = if s.state == LspState::Unavailable {
                    Some(s.message.clone().unwrap_or_else(|| "unavailable".into()))
                } else {
                    s.notice.as_ref().map(|n| n.message.clone())
                };
                let Some(message) = message else {
                    reported.remove(&s.command);
                    continue;
                };
                if reported.get(&s.command) != Some(&message) {
                    crate::status!("{} lsp {}: {message}", red("✖"), s.name);
                    reported.insert(s.command.clone(), message);
                }
            }
            broadcast.broadcast(ServerMessage::Lsp { payload: status });
        }),
        overrides,
        preload,
        lookup: default_lookup(),
        max_open: None,
    });
    let tracking = Arc::downgrade(&pool);
    session.on_snapshot(move |snap: &Arc<Snapshot>| {
        let (pool, snap) = (tracking.upgrade(), snap.clone());
        if let Some(pool) = pool {
            tokio::spawn(async move { pool.track(&snap).await });
        }
    });
    pool
}

/// The startup lines: what serves the diff, or why nothing can.
pub fn report(pool: &LspPool, snap: &Snapshot) {
    let status = pool.status();
    if readable_by_servers(Some(snap)) {
        let names: Vec<String> = status
            .servers
            .iter()
            .map(|s| format!("{} {}", s.name, dim(&format!("({})", languages_label(s)))))
            .collect();
        let names = if names.is_empty() { dim("no language server for this diff") } else { names.join(", ") };
        crate::status!("🧭 {} {names}", dim("lsp"));
    } else {
        crate::status!("🧭 {}", dim("no language server: symbol navigation needs the new side to be the checkout"));
    }
    // Languages turned off in the config stay quiet; a missing program is worth saying once.
    for m in status.missing.iter().filter(|m| !m.tried.is_empty()) {
        crate::status!(
            "{} no {} language server {}",
            yellow("!"),
            m.language,
            dim(&format!("(tried {})", m.tried.join(", ")))
        );
    }
}

/// `diffle lsp`: the server each language would get, and what is missing from PATH. The resolver
/// decides; this only prints what a run would start, said the same way.
pub async fn list() -> anyhow::Result<()> {
    let store = UserConfigStore::open(UserConfigStore::default_path()).await;
    let commands: HashMap<LanguageId, String> = store.get().lsp_commands.into_iter().collect();
    let languages = language_ids();
    let resolution = resolve_servers(languages.clone(), &commands, &default_lookup());
    let mut answer: HashMap<LanguageId, String> = HashMap::new();
    for s in &resolution.servers {
        for language in &s.languages {
            let config = if commands.contains_key(language) { dim(" (config)") } else { String::new() };
            answer.insert(*language, format!("{}{config}", s.command));
        }
    }
    // An empty override is off, and names nothing to install: the resolver leaves `tried` empty.
    for m in &resolution.missing {
        let why = m.why.clone().unwrap_or_else(|| {
            if m.tried.is_empty() {
                "off in config".into()
            } else {
                format!("not on PATH (tried {})", m.tried.join(", "))
            }
        });
        answer.insert(m.language, dim(&why));
    }
    // A server joining a language answers beside its owner, so it is listed after it.
    for s in &resolution.servers {
        for language in &s.joins {
            let before = answer.get(language).cloned().unwrap_or_default();
            answer.insert(*language, format!("{before} {} {}", dim("+"), s.command));
        }
    }
    let width = languages.iter().map(|l| l.to_string().len()).max().unwrap_or(0);
    for language in languages {
        println!("{:width$}  {}", language.to_string(), answer.get(&language).cloned().unwrap_or_default());
    }
    Ok(())
}
