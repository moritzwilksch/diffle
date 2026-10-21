//! A real server over a temporary repository, and a client that may set any header.
use std::sync::Arc;

use diffle::github::hosts::Github;
use diffle::lsp::pool::{LspPool, PoolOptions};
use diffle::protocol::{EnterRequest, FollowRefs, LanguageId, Side};
use diffle::server::hub::Hub;
use diffle::server::{ApiDeps, Server, ServerOptions};
use diffle::session::{Session, SessionOptions};
use diffle::user_config::UserConfigStore;
use futures::FutureExt;

use super::TestRepo;

/// A pool reading new-side text through the session, so the snapshot allowlist applies, and tracking
/// every snapshot. Overrides are never probed; the rest of PATH is not consulted.
fn start_lsp(session: &Arc<Session>, overrides: std::collections::HashMap<LanguageId, String>) -> Arc<LspPool> {
    let (reader, checker) = (Arc::downgrade(session), Arc::downgrade(session));
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
        on_status: Arc::new(|_| {}),
        overrides,
        preload: Vec::new(),
        lookup: Arc::new(|_| None),
        max_open: None,
    });
    let tracking = Arc::downgrade(&pool);
    session.on_snapshot(move |snap| {
        let (pool, snap) = (tracking.upgrade(), snap.clone());
        if let Some(pool) = pool {
            tokio::spawn(async move { pool.track(&snap).await });
        }
    });
    pool
}

pub struct TestServer {
    pub repo: TestRepo,
    pub session: Arc<Session>,
    pub config: Arc<UserConfigStore>,
    pub hub: Arc<Hub>,
    /// `http://127.0.0.1:<port>/`
    pub base: String,
    server: Option<Server>,
    pub lsp: Option<Arc<LspPool>>,
    client: reqwest::Client,
}

pub struct Res {
    pub status: u16,
    pub body: String,
}

impl Res {
    pub fn json(&self) -> serde_json::Value {
        serde_json::from_str(&self.body).unwrap_or_else(|e| panic!("not JSON ({e}): {}", self.body))
    }
}

impl TestServer {
    /// `a.txt` committed on main, reviewed in working mode, trusting `https://proxy.example`.
    pub async fn start() -> Self {
        let repo = TestRepo::new();
        repo.write("a.txt", "a\n");
        repo.commit("base");
        Self::over(repo, EnterRequest::Working).await
    }

    /// A server over `repo`, reviewing `req`.
    pub async fn over(repo: TestRepo, req: EnterRequest) -> Self {
        Self::with_lsp(repo, req, None).await
    }

    /// A server over `repo` with language servers for `overrides` (language → command), started
    /// and kept in step with the session's snapshots as a run does it.
    pub async fn with_lsp(
        repo: TestRepo,
        req: EnterRequest,
        overrides: Option<std::collections::HashMap<diffle::protocol::LanguageId, String>>,
    ) -> Self {
        let git = Arc::new(repo.open().await);
        let hub = Hub::new();
        let config = Arc::new(UserConfigStore::open(repo.path.join("cfg").join("config.json")).await);
        let opts =
            SessionOptions { watch: false, github: Github::tokenless(), context: 3, follow_refs: FollowRefs::Off };
        let session = Session::new(git, hub.clone(), opts);
        let lsp = overrides.map(|overrides| start_lsp(&session, overrides));
        let deps = ApiDeps {
            session: session.clone(),
            config: config.clone(),
            extra_auto_viewed: Vec::new(),
            hub: hub.clone(),
            lsp: lsp.clone(),
        };
        let opts = ServerOptions {
            port: 0,
            probe: false,
            host: "127.0.0.1".into(),
            allowed_origin: Some("https://proxy.example".into()),
        };
        let (server, base) = Server::listen(deps, opts).await.unwrap();
        session.start(session.resolve(req).await.unwrap()).await.unwrap();
        Self { repo, session, config, hub, base, server: Some(server), lsp, client: reqwest::Client::new() }
    }

    /// `127.0.0.1:<port>`
    pub fn host(&self) -> String {
        self.base.trim_start_matches("http://").trim_end_matches('/').to_owned()
    }

    pub fn ws_url(&self) -> String {
        format!("ws://{}/ws", self.host())
    }

    pub async fn send(&self, method: &str, path: &str, headers: &[(&str, &str)], body: Option<String>) -> Res {
        let url = format!("{}{}", self.base.trim_end_matches('/'), path);
        let mut req = self.client.request(method.parse().unwrap(), url).header("content-type", "application/json");
        for (name, value) in headers {
            req = req.header(*name, *value);
        }
        if let Some(body) = body {
            req = req.body(body);
        }
        let res = req.send().await.unwrap();
        Res { status: res.status().as_u16(), body: res.text().await.unwrap() }
    }

    /// A GET whose response the caller reads itself: headers and bytes.
    pub async fn fetch(&self, path: &str) -> reqwest::Response {
        self.client.get(format!("{}{}", self.base.trim_end_matches('/'), path)).send().await.unwrap()
    }

    pub async fn get(&self, path: &str) -> Res {
        self.send("GET", path, &[], None).await
    }

    pub async fn json(&self, method: &str, path: &str, body: serde_json::Value) -> Res {
        self.send(method, path, &[], Some(body.to_string())).await
    }

    pub async fn close(mut self) {
        if let Some(server) = self.server.take() {
            server.close().await;
        }
        if let Some(lsp) = self.lsp.take() {
            lsp.close().await;
        }
        self.session.close().await;
    }
}
