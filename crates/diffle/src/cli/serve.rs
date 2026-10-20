//! A review run: open the repository, resolve the request, serve it, and hand off the prompt at the end.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::Notify;

use super::args::GlobalOpts;
use super::lifetime::{GRACE, last_tab_closed};
use super::open::open_browser;
use super::paint::{bold, cyan, dim, green, red, yellow};
use super::timing::Timing;
use crate::comments::format::format_prompt;
use crate::git::GitRepo;
use crate::github::client::token_variables;
use crate::github::hosts::{GithubInstance, choose_instance};
use crate::protocol::{Live, ModeRequest, Snapshot, ThreadQuery, ThreadState, comparison_label};
use crate::server::hub::Hub;
use crate::server::{ApiDeps, DEFAULT_PORT, Server, ServerOptions};
use crate::session::{Session, SessionOptions};
use crate::user_config::UserConfigStore;

/// How long the HTTP server may take to close once the session has settled.
const CLOSE_BOUND: Duration = Duration::from_millis(1500);

/// Serves `req` until a signal or the last auto-opened tab ends the run. Fails, before anything
/// is served, when the request does not resolve.
pub async fn run(req: ModeRequest, opts: GlobalOpts) -> anyhow::Result<()> {
    let mut timing = Timing::new(opts.timing);
    let config = Arc::new(UserConfigStore::open(UserConfigStore::default_path()).await);
    let dir = match &opts.dir {
        Some(dir) => dir.clone(),
        None => std::env::current_dir()?,
    };
    let repo = Arc::new(GitRepo::open(&dir).await?);
    let selector = match &req {
        ModeRequest::Pr { pr } => pr.as_deref(),
        _ => None,
    };
    let instance = choose_instance(&config.get().github_hosts, Some(&repo), selector).await;
    timing.mark("open repository");

    let hub = Hub::new();
    let context = opts.context.unwrap_or_else(|| config.get().context_lines.clamp(0, 10_000) as u32);
    let session_opts = SessionOptions {
        watch: !opts.no_watch,
        instance: instance.clone(),
        context,
        follow_refs: config.get().follow_refs,
    };
    let session = Session::new(repo.clone(), hub.clone(), session_opts);
    let server: Arc<Mutex<Option<Server>>> = Arc::default();

    let stop = Arc::new(Notify::new());
    let trigger = stop.clone();
    tokio::spawn(async move {
        signal().await;
        trigger.notify_one();
    });
    if !opts.no_open && !opts.keep_alive {
        let (clients, trigger) = (hub.clients(), stop.clone());
        tokio::spawn(async move {
            last_tab_closed(clients, GRACE).await;
            trigger.notify_one();
        });
    }

    let startup = start(req, &opts, &session, &config, &hub, &server, &repo, &instance, &mut timing);
    let started = tokio::select! {
        started = startup => Some(started),
        () = stop.notified() => None,
    };
    match started {
        Some(Err(e)) => {
            dispose(&session, &server, &repo).await;
            Err(e)
        }
        Some(Ok(())) => {
            stop.notified().await;
            shutdown(&session, &server, &repo).await;
            Ok(())
        }
        None => {
            shutdown(&session, &server, &repo).await;
            Ok(())
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn start(
    req: ModeRequest,
    opts: &GlobalOpts,
    session: &Arc<Session>,
    config: &Arc<UserConfigStore>,
    hub: &Arc<Hub>,
    server: &Mutex<Option<Server>>,
    repo: &GitRepo,
    instance: &GithubInstance,
    timing: &mut Timing,
) -> anyhow::Result<()> {
    // Resolve the revision before binding, so invalid input never opens a browser.
    let review = session.resolve(req).await?;
    timing.mark("resolve");
    let deps = ApiDeps {
        session: session.clone(),
        config: config.clone(),
        extra_auto_viewed: opts.auto_viewed.clone(),
        hub: hub.clone(),
    };
    let server_opts = ServerOptions {
        port: opts.port.unwrap_or(DEFAULT_PORT),
        probe: opts.port.is_none(),
        host: opts.host().to_owned(),
        allowed_origin: opts.allowed_origin.clone(),
    };
    let (bound, url) = Server::listen(deps, server_opts).await?;
    *server.lock().unwrap() = Some(bound);
    timing.mark("listen");
    if !opts.no_open {
        let browser = if opts.host() == "0.0.0.0" || opts.host() == "::" { localhost(&url) } else { url.clone() };
        open_browser(&browser);
    }
    eprintln!("🚀 diffle running at {}", cyan(&url));
    eprintln!("📂 {} {}", dim("repo"), repo.root.display());
    let host = &instance.host;
    let label = dim(&if host == "github.com" { "github".to_owned() } else { format!("github {host}") });
    let vars = token_variables(host).join(", ");
    eprintln!("🐙 {label} {}", dim(&format!("off: no token in {vars} or gh auth token --hostname {host}")));

    let snap = session.start(review).await?;
    timing.mark("snapshot");
    report(&snap, session.follows().unwrap_or(false), !opts.no_watch);
    timing.report();
    Ok(())
}

fn report(snap: &Snapshot, follows: bool, watch: bool) {
    let n = snap.changed.len();
    let adds: i64 = snap.changed.iter().map(|f| f.additions).sum();
    let dels: i64 = snap.changed.iter().map(|f| f.deletions).sum();
    eprintln!("🔍 {} {}", dim("comparing"), bold(&comparison_label(&snap.mode)));
    if n == 0 {
        eprintln!("{} No differences. Open any file from the tree to comment on it.", yellow("!"));
    } else {
        let files = if n == 1 { "file" } else { "files" };
        eprintln!("📝 {n} changed {files}  {} {}", green(&format!("+{adds}")), red(&format!("−{dels}")));
    }
    if snap.mode.live != Live::None {
        let what = match (snap.mode.live, follows) {
            (Live::Worktree, _) => "watching the worktree",
            (_, true) => "watching refs",
            _ => "watching refs; moved refs show a Reload button",
        };
        let off = if watch { String::new() } else { dim(" (disabled with --no-watch)") };
        eprintln!("👀 {}{off}", dim(what));
    }
}

/// The URL with its host replaced by `localhost`: a wildcard bind is not an address a browser opens.
fn localhost(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(mut parsed) => {
            let _ = parsed.set_host(Some("localhost"));
            parsed.to_string()
        }
        Err(_) => url.to_owned(),
    }
}

/// The handoff: the open threads, as a prompt, on stdout. Nothing else in the run writes there.
async fn shutdown(session: &Arc<Session>, server: &Mutex<Option<Server>>, repo: &GitRepo) {
    eprintln!("\n👋 {}", dim("shutting down"));
    if let Ok(comments) = session.comments() {
        let open = ThreadQuery { path: None, state: Some(ThreadState::Open) };
        if let Ok(threads) = comments.threads(&open).await {
            print!("{}", format_prompt(&threads));
            use std::io::Write;
            let _ = std::io::stdout().flush();
        }
    }
    dispose(session, server, repo).await;
}

/// Releases everything the run holds, whatever ended it: git settles before its refs go, the
/// sockets close within a bound.
async fn dispose(session: &Arc<Session>, server: &Mutex<Option<Server>>, repo: &GitRepo) {
    let server = server.lock().unwrap().take();
    let close_server = async {
        if let Some(server) = server {
            let _ = tokio::time::timeout(CLOSE_BOUND, server.close()).await;
        }
    };
    tokio::join!(session.close(), close_server);
    if let Err(e) = repo.clean_review_refs().await {
        eprintln!("{} {e}", red("✖"));
    }
}

/// Ctrl+C, or SIGTERM where there is one.
async fn signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}
