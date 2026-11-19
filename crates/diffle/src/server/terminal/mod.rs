//! Local browser terminals. The server owns the layout and PTYs for the lifetime of the run.
mod pty;
mod session;

use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message, WebSocket, close_code};
use axum::extract::{Query, State, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode, header, uri::Authority};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::Deserialize;
use tokio::sync::{Semaphore, watch};

use self::session::{Input, Pane};
use crate::protocol::{TerminalAccess, TerminalLayout, TerminalReplay, TerminalResize, TerminalTab};

const FRAME_LIMIT: usize = 64 * 1024;
pub const MAX_TERMINALS: usize = 12;

struct Terminals {
    port: u16,
    dir: PathBuf,
    commands: Vec<String>,
    token: String,
    slots: Arc<Semaphore>,
    shutdown: watch::Receiver<bool>,
    workspace: Mutex<Workspace>,
}

struct Workspace {
    layout: TerminalLayout,
    running: HashMap<i64, Arc<Pane>>,
}

pub(super) fn router(dir: PathBuf, startup: Vec<Vec<String>>, port: u16, shutdown: watch::Receiver<bool>) -> Router {
    let mut commands = Vec::new();
    let tabs: Vec<_> = startup
        .into_iter()
        .map(|tab| {
            let id = commands.len() as i64 + 1;
            commands.extend(tab);
            let panes = (id..=commands.len() as i64).collect();
            TerminalTab { id, panes, active_pane: id }
        })
        .collect();
    let layout = TerminalLayout {
        updated_at: 0,
        active: tabs.first().map(|tab| tab.id),
        open: !tabs.is_empty(),
        next: commands.len() as i64 + 1,
        tabs,
    };
    let state = Arc::new(Terminals {
        port,
        dir,
        commands,
        token: uuid::Uuid::new_v4().to_string(),
        slots: Arc::new(Semaphore::new(2 * MAX_TERMINALS)),
        shutdown,
        workspace: Mutex::new(Workspace { layout, running: HashMap::new() }),
    });
    Router::new()
        .route("/api/terminal/access", post(access))
        .route("/api/terminal/layout", put(set_layout))
        .route("/api/terminal/socket", get(connect))
        .with_state(state)
}

fn same_origin(headers: &HeaderMap, port: u16) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|value| value.to_str().ok()) else { return false };
    let Ok(authority) = host.parse::<Authority>() else { return false };
    let name = authority.host().trim_matches(['[', ']']);
    let loopback = name == "localhost" || name.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback());
    loopback
        && authority.port_u16().unwrap_or(80) == port
        && headers.get(header::ORIGIN).is_some_and(|value| value == format!("http://{host}").as_str())
}

async fn access(State(state): State<Arc<Terminals>>, headers: HeaderMap) -> Response {
    if !same_origin(&headers, state.port) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let access = TerminalAccess { token: state.token.clone(), layout: state.workspace.lock().unwrap().layout.clone() };
    ([(header::CACHE_CONTROL, "no-store")], axum::Json(access)).into_response()
}

#[derive(Deserialize)]
struct Capability {
    token: String,
}

#[derive(Deserialize)]
struct Connection {
    token: String,
    pane: i64,
}

fn pane_ids(layout: &TerminalLayout) -> impl Iterator<Item = i64> + '_ {
    layout.tabs.iter().flat_map(|tab| tab.panes.iter().copied())
}

fn valid_layout(layout: &TerminalLayout) -> Option<HashSet<i64>> {
    let mut ids = HashSet::new();
    let mut tabs = HashSet::new();
    for tab in &layout.tabs {
        if tab.id <= 0 || tab.id >= layout.next || !tabs.insert(tab.id) || !tab.panes.contains(&tab.active_pane) {
            return None;
        }
        for id in &tab.panes {
            if *id <= 0 || *id >= layout.next || !ids.insert(*id) || ids.len() > MAX_TERMINALS {
                return None;
            }
        }
    }
    (layout.next > 0 && layout.active.map_or(tabs.is_empty(), |id| tabs.contains(&id))).then_some(ids)
}

async fn set_layout(
    State(state): State<Arc<Terminals>>,
    Query(capability): Query<Capability>,
    headers: HeaderMap,
    Json(layout): Json<TerminalLayout>,
) -> StatusCode {
    if !same_origin(&headers, state.port) || capability.token != state.token {
        return StatusCode::FORBIDDEN;
    }
    let Some(ids) = valid_layout(&layout) else { return StatusCode::BAD_REQUEST };
    let mut workspace = state.workspace.lock().unwrap();
    if layout.updated_at <= workspace.layout.updated_at {
        return StatusCode::NO_CONTENT;
    }
    let old_ids: HashSet<_> = pane_ids(&workspace.layout).collect();
    if layout.next < workspace.layout.next || ids.iter().any(|id| *id < workspace.layout.next && !old_ids.contains(id))
    {
        return StatusCode::CONFLICT;
    }
    workspace.running.retain(|id, pane| {
        if ids.contains(id) {
            return true;
        }
        pane.closed.send_replace(true);
        false
    });
    workspace.layout = layout;
    StatusCode::NO_CONTENT
}

async fn connect(
    State(state): State<Arc<Terminals>>,
    Query(connection): Query<Connection>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    if !same_origin(&headers, state.port) || connection.token != state.token {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Ok(slot) = state.slots.clone().try_acquire_owned() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    upgrade.max_frame_size(FRAME_LIMIT).max_message_size(FRAME_LIMIT).on_upgrade(move |socket| async move {
        let _slot = slot;
        serve(socket, state, connection.pane).await;
    })
}

async fn serve(mut socket: WebSocket, state: Arc<Terminals>, id: i64) {
    let mut shutdown = state.shutdown.clone();
    let first = tokio::select! {
        _ = async { let _ = shutdown.wait_for(|stopped| *stopped).await; } => return,
        first = tokio::time::timeout(std::time::Duration::from_secs(5), socket.recv()) => first,
    };
    let Ok(Some(Ok(Message::Text(first)))) = first else { return };
    let Some(size) = resize(&first) else { return };
    let pane = {
        let mut workspace = state.workspace.lock().unwrap();
        let exists = pane_ids(&workspace.layout).any(|pane| pane == id);
        exists.then(|| {
            let resuming = workspace.running.contains_key(&id);
            let pane = workspace
                .running
                .entry(id)
                .or_insert_with(|| {
                    let command =
                        state.commands.get(id as usize - 1).filter(|command| !command.trim().is_empty()).cloned();
                    Pane::start(state.dir.clone(), size, command, state.shutdown.clone())
                })
                .clone();
            (pane, resuming)
        })
    };
    let Some((pane, resuming)) = pane else {
        close_pane(&mut socket).await;
        return;
    };
    let mut closed = pane.closed.subscribe();
    let (replay, mut output) = pane.subscribe();
    let _ = pane.input.try_send(Input::Resize(size));
    if resuming {
        let replay_chunks = replay.iter().filter(|frame| matches!(frame, Message::Binary(_))).count() as i64;
        let marker = serde_json::to_string(&TerminalReplay { replay_chunks }).expect("terminal replay serializes");
        if !send(&mut socket, Message::Text(marker.into())).await {
            return;
        }
    }
    for frame in replay {
        if !send(&mut socket, frame).await {
            return;
        }
    }
    loop {
        tokio::select! {
            _ = async { drop(shutdown.wait_for(|stopped| *stopped).await) } => break,
            _ = async { drop(closed.wait_for(|closed| *closed).await) } => {
                close_pane(&mut socket).await;
                break;
            },
            frame = output.recv() => {
                let Ok(frame) = frame else { break };
                if !send(&mut socket, frame).await { break }
            }
            input = socket.recv() => match input {
                Some(Ok(Message::Binary(bytes))) => {
                    if tokio::time::timeout(Duration::from_secs(1), pane.input.send(Input::Bytes(bytes))).await.is_err() {
                        break;
                    }
                }
                Some(Ok(Message::Text(text))) => {
                    let Some(size) = resize(&text) else { break };
                    let _ = pane.input.try_send(Input::Resize(size));
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                _ => break,
            },
        }
    }
}

async fn send(socket: &mut WebSocket, message: Message) -> bool {
    matches!(tokio::time::timeout(Duration::from_secs(1), socket.send(message)).await, Ok(Ok(())))
}

async fn close_pane(socket: &mut WebSocket) {
    send(socket, Message::Close(Some(CloseFrame { code: close_code::POLICY, reason: "Terminal closed".into() }))).await;
}

fn resize(text: &str) -> Option<portable_pty::PtySize> {
    let req: TerminalResize = serde_json::from_str(text).ok()?;
    if req.cols.get() > 500 || req.rows.get() > 300 {
        return None;
    }
    Some(portable_pty::PtySize {
        cols: req.cols.get() as u16,
        rows: req.rows.get() as u16,
        pixel_width: 0,
        pixel_height: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_requires_an_explicit_loopback_origin_for_the_bound_port() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "localhost:4000".parse().unwrap());
        assert!(!same_origin(&headers, 4000));
        headers.insert(header::ORIGIN, "http://localhost:4000".parse().unwrap());
        assert!(same_origin(&headers, 4000));
        assert!(!same_origin(&headers, 4001));
        headers.insert(header::ORIGIN, "http://other.example".parse().unwrap());
        assert!(!same_origin(&headers, 4000));
        headers.insert(header::HOST, "other.example:4000".parse().unwrap());
        headers.insert(header::ORIGIN, "http://other.example:4000".parse().unwrap());
        assert!(!same_origin(&headers, 4000));
    }
}
