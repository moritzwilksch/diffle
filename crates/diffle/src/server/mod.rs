//! The HTTP server: the API, the WebSocket hub, and the embedded client.
pub mod announce;
mod assets;
pub mod guard;
pub mod hub;
pub mod image;
mod listen;
mod routes;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Request, State, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http_body_util::BodyExt;
use tokio::sync::watch;
use tower_http::compression::CompressionLayer;

use crate::session::Session;
use crate::user_config::UserConfigStore;
use guard::RequestGuard;
use hub::Hub;
use routes::ApiError;

/// Default port, chosen to be unassigned and memorable; `--port` overrides it.
pub const DEFAULT_PORT: u16 = 4966;
/// JSON bodies are small (comments, viewed marks, config); anything bigger is not a client.
const MAX_BODY_BYTES: usize = 1024 * 1024;

pub struct ServerOptions {
    pub endpoint: Endpoint,
    pub allowed_origin: Option<String>,
}

pub enum Endpoint {
    /// A port on `host`; with `probe`, the first free one at or above `port` instead of failing.
    Tcp { host: String, port: u16, probe: bool },
    /// A Unix socket at this path that only this user may connect to, removed when the server closes.
    #[cfg(unix)]
    Unix(PathBuf),
}

pub struct ApiDeps {
    pub session: Arc<Session>,
    pub config: Arc<UserConfigStore>,
    /// Session-only additions from `--auto-viewed`.
    pub extra_auto_viewed: Vec<String>,
    pub hub: Arc<Hub>,
    /// The language servers, unless the run disabled them with `--no-lsp`.
    pub lsp: Option<Arc<crate::lsp::pool::LspPool>>,
}

struct App {
    deps: Arc<ApiDeps>,
    guard: RequestGuard,
}

pub struct Server {
    hub: Arc<Hub>,
    stop: watch::Sender<bool>,
    serving: tokio::task::JoinHandle<()>,
    socket: Option<PathBuf>,
}

impl Server {
    /// Binds the endpoint, serves, and returns where: the URL, or `unix:<path>` for a socket.
    pub async fn listen(deps: ApiDeps, opts: ServerOptions) -> anyhow::Result<(Server, String)> {
        let hub = deps.hub.clone();
        // A socket's clients arrive through a local forward, so they name a loopback host.
        let host = match &opts.endpoint {
            Endpoint::Tcp { host, .. } => host.as_str(),
            #[cfg(unix)]
            Endpoint::Unix(_) => "127.0.0.1",
        };
        let guard = RequestGuard::for_host(host, opts.allowed_origin.as_deref());
        let router = router(Arc::new(App { deps: Arc::new(deps), guard }));
        let (stop, stopped) = watch::channel(false);
        let (serving, at, socket) = match opts.endpoint {
            Endpoint::Tcp { host, port, probe } => {
                let listener = listen::tcp(&host, port, probe).await?;
                let at = url(&host, listener.local_addr()?);
                (spawn(listener, router, stopped), at, None)
            }
            #[cfg(unix)]
            Endpoint::Unix(path) => {
                use anyhow::Context as _;
                let listener =
                    listen::unix(&path).await.with_context(|| format!("cannot listen on {}", path.display()))?;
                (spawn(listener, router, stopped), format!("unix:{}", path.display()), Some(path))
            }
        };
        Ok((Server { hub, stop, serving, socket }, at))
    }

    /// Stops accepting, ends every WebSocket, and waits for requests in flight.
    pub async fn close(self) {
        self.hub.close();
        self.stop.send_replace(true);
        let _ = self.serving.await;
        if let Some(socket) = self.socket {
            let _ = std::fs::remove_file(socket);
        }
    }
}

fn spawn<L>(listener: L, router: Router, mut stopped: watch::Receiver<bool>) -> tokio::task::JoinHandle<()>
where
    L: axum::serve::Listener,
    L::Addr: std::fmt::Debug,
{
    tokio::spawn(async move {
        let shutdown = async move {
            let _ = stopped.wait_for(|stop| *stop).await;
        };
        if let Err(e) = axum::serve(listener, router).with_graceful_shutdown(shutdown).await {
            crate::status!("[diffle] server failed: {e}");
        }
    })
}

fn url(host: &str, addr: SocketAddr) -> String {
    let host = if host.contains(':') { format!("[{host}]") } else { host.to_owned() };
    format!("http://{host}:{}/", addr.port())
}

fn router(app: Arc<App>) -> Router {
    // Layers wrap only the routes added before them, so the fallback below stays unguarded for assets.
    let api = routes::router()
        .layer(middleware::from_fn_with_state(app.deps.clone(), wait_ready))
        .layer(CompressionLayer::new())
        .layer(middleware::from_fn(limit_body))
        .layer(middleware::from_fn_with_state(app.clone(), check_guard))
        .with_state(app.deps.clone());
    Router::new().merge(api).route("/ws", get(ws)).fallback(fallback).with_state(app)
}

/// Unknown API paths answer JSON behind the guard; everything else is the client.
async fn fallback(State(app): State<Arc<App>>, req: Request) -> Response {
    if !req.uri().path().starts_with("/api/") {
        return assets::serve(req).await;
    }
    let headers = req.headers();
    if let Some(rejected) = app.guard.check(header(headers, header::HOST), header(headers, header::ORIGIN)) {
        return ApiError(StatusCode::FORBIDDEN, rejected).into_response();
    }
    ApiError::not_found("API endpoint not found. Restart diffle to load the latest server.").into_response()
}

fn header(headers: &HeaderMap, name: header::HeaderName) -> Option<&str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

async fn check_guard(State(app): State<Arc<App>>, req: Request, next: Next) -> Response {
    let headers = req.headers();
    match app.guard.check(header(headers, header::HOST), header(headers, header::ORIGIN)) {
        Some(rejected) => ApiError(StatusCode::FORBIDDEN, rejected).into_response(),
        None => next.run(req).await,
    }
}

/// Reads the body under the cap. An oversized upload is drained before the reply: closing
/// mid-write gives clients EPIPE, not 413.
async fn limit_body(req: Request, next: Next) -> Response {
    let (parts, mut body) = req.into_parts();
    let mut kept = Vec::new();
    let mut size = 0;
    while let Some(frame) = body.frame().await {
        let Ok(frame) = frame else { return ApiError::bad_request("unreadable request body").into_response() };
        if let Some(data) = frame.data_ref() {
            size += data.len();
            if size <= MAX_BODY_BYTES {
                kept.extend_from_slice(data);
            }
        }
    }
    if size > MAX_BODY_BYTES {
        return ApiError(StatusCode::PAYLOAD_TOO_LARGE, "request body too large".into()).into_response();
    }
    next.run(Request::from_parts(parts, Body::from(Bytes::from(kept)))).await
}

/// Paths that answer before the first mode resolves: a client probes the version and loads the
/// config while the review is still being computed.
const EARLY_PATHS: [&str; 2] = ["/api/version", "/api/config"];

/// Every request but the early paths waits for the first mode to resolve.
async fn wait_ready(State(deps): State<Arc<ApiDeps>>, req: Request, next: Next) -> Response {
    if !EARLY_PATHS.contains(&req.uri().path())
        && let Err(e) = deps.session.ready().await
    {
        return ApiError::from(e).into_response();
    }
    next.run(req).await
}

async fn ws(State(app): State<Arc<App>>, headers: HeaderMap, upgrade: WebSocketUpgrade) -> Response {
    // Name the failing header, as the API does: a bare hangup leaves the browser log blank.
    if let Some(rejected) = app.guard.check(header(&headers, header::HOST), header(&headers, header::ORIGIN)) {
        return (StatusCode::FORBIDDEN, [(header::CONTENT_TYPE, "text/plain")], format!("{rejected}\n"))
            .into_response();
    }
    let hub = app.deps.hub.clone();
    upgrade.max_message_size(hub::MAX_PAYLOAD_BYTES).on_upgrade(move |socket| hub.serve(socket))
}
