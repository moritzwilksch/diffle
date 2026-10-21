//! One language server process: the only place that starts one.
mod capabilities;
mod child;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;

use capabilities::truthy;
use child::{command, signal, spawn_settled};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use futures::future::{BoxFuture, Shared};
use serde_json::{Value, json};
use tokio::sync::watch;

use crate::error::{Error, Result};
use crate::lsp::output::{OutputChange, ServerOutput};
use crate::lsp::rpc::{Connection, RequestError};
use crate::lsp::shapes::{all_features, client_capabilities, provider_of};
use crate::lsp::which::program_of;
use crate::protocol::{LspFeature, LspLogEntry, LspProcessStatus, LspState};

/// A server's settings tree, as `workspace/didChangeConfiguration` carries it.
pub type Settings = Value;
pub type SettingsFuture = Shared<BoxFuture<'static, Settings>>;

const INIT_TIMEOUT: Duration = Duration::from_secs(60);
/// Graceful shutdown budget; both together stay under the CLI's bound on closing.
const SHUTDOWN_RPC: Duration = Duration::from_millis(500);
const KILL_AFTER: Duration = Duration::from_millis(500);

pub struct ProcessOptions {
    /// Shell command line that starts a stdio language server, e.g. `pyrefly lsp`.
    pub command: String,
    /// Repository root; becomes the workspace folder and the process cwd.
    pub root: PathBuf,
    /// Settings sent after initialization and returned for `workspace/configuration` requests.
    pub settings: Option<SettingsFuture>,
    /// Sent with `initialize`, for servers configured there rather than through settings.
    pub initialization_options: Option<Value>,
    pub on_status: Arc<dyn Fn(&LspProcessStatus) + Send + Sync>,
}

struct State {
    current: LspProcessStatus,
    /// Features the server offers, from `initialize` and from registrations since.
    advertised: Vec<LspFeature>,
    /// Dynamic registrations by id, so an unregistration knows which feature it ends.
    registrations: HashMap<String, LspFeature>,
    /// What the server is answered from: the latest `reconfigure`'s, else the options'.
    settings: Option<SettingsFuture>,
    closing: bool,
    rpc: Option<Connection>,
    pid: Option<u32>,
}

/// Runs the `initialize` handshake, keeps the status (with what `ServerOutput` reports), and shuts
/// the server down. Speaks no document or query protocol. Never fails to construct: failures
/// become a status the UI can show.
pub struct LspProcess {
    command: String,
    on_status: Arc<dyn Fn(&LspProcessStatus) + Send + Sync>,
    state: Mutex<State>,
    output: Mutex<ServerOutput>,
    /// Set once the handshake settles: true when the server is ready.
    ready: watch::Sender<Option<bool>>,
    exited: watch::Sender<bool>,
}

impl LspProcess {
    pub fn start(opts: ProcessOptions) -> Arc<Self> {
        let current = LspProcessStatus {
            name: program_of(&opts.command),
            command: opts.command.clone(),
            state: LspState::Starting,
            message: None,
            activity: Vec::new(),
            notice: None,
            log: crate::protocol::LspLogCounts { seq: 0, errors: 0, warnings: 0 },
        };
        let process = Arc::new_cyclic(|me: &Weak<Self>| {
            let me = me.clone();
            Self {
                command: opts.command.clone(),
                on_status: opts.on_status.clone(),
                state: Mutex::new(State {
                    current,
                    advertised: Vec::new(),
                    registrations: HashMap::new(),
                    settings: opts.settings.clone(),
                    closing: false,
                    rpc: None,
                    pid: None,
                }),
                output: Mutex::new(ServerOutput::new(move |change| {
                    if let Some(me) = me.upgrade() {
                        me.apply(change);
                    }
                })),
                ready: watch::channel(None).0,
                exited: watch::channel(false).0,
            }
        });
        let launching = process.clone();
        tokio::spawn(async move {
            let ok = launching.launch(opts).await.is_ok();
            launching.ready.send_replace(Some(ok));
        });
        process
    }

    /// How messages name the server: `basedpyright-langserver --stdio` → `basedpyright-langserver`.
    pub fn name(&self) -> String {
        program_of(&self.command)
    }

    pub fn status(&self) -> LspProcessStatus {
        self.state.lock().unwrap().current.clone()
    }

    /// The retained log lines, oldest first.
    pub fn entries(&self) -> Vec<LspLogEntry> {
        self.output.lock().unwrap().entries()
    }

    /// Whether the server advertised `f`, at `initialize` or by registering it since.
    pub fn supports(&self, f: LspFeature) -> bool {
        self.state.lock().unwrap().advertised.contains(&f)
    }

    pub fn features(&self) -> Vec<LspFeature> {
        self.state.lock().unwrap().advertised.clone()
    }

    /// The background work the server reports, as a reason an empty answer may be incomplete.
    pub fn busy(&self) -> Option<String> {
        let state = self.state.lock().unwrap();
        let work = &state.current.activity;
        (!work.is_empty())
            .then(|| format!("{} is busy: {}; try again when it finishes", state.current.name, work.join("; ")))
    }

    /// Answers the server from `settings` from now on, and sends them once it is initialized unless
    /// they are what it already has. A later call supersedes one still pending.
    pub fn reconfigure(self: &Arc<Self>, settings: SettingsFuture) {
        let before = self.state.lock().unwrap().settings.replace(settings.clone());
        let this = self.clone();
        tokio::spawn(async move {
            if !this.wait_ready().await {
                return;
            }
            let previous = match before {
                Some(before) => Some(before.await),
                None => None,
            };
            let next = settings.clone().await;
            let state = this.state.lock().unwrap();
            let current = state.settings.as_ref().is_some_and(|s| s.ptr_eq(&settings));
            if state.closing || !current || previous.as_ref() == Some(&next) {
                return;
            }
            if let Some(rpc) = &state.rpc {
                rpc.notify("workspace/didChangeConfiguration", json!({ "settings": next }));
            }
        });
    }

    async fn wait_ready(&self) -> bool {
        let mut ready = self.ready.subscribe();
        matches!(ready.wait_for(Option::is_some).await.map(|r| *r), Ok(Some(true)))
    }

    /// The connection once initialized; `LspUnavailable` when the server is gone.
    pub async fn connection(&self) -> Result<Connection> {
        let ready = self.wait_ready().await;
        let state = self.state.lock().unwrap();
        let unavailable = || {
            Error::LspUnavailable(state.current.message.clone().unwrap_or_else(|| "language server unavailable".into()))
        };
        match (&state.rpc, ready && state.current.state == LspState::Ready) {
            (Some(rpc), true) => Ok(rpc.clone()),
            _ => Err(unavailable()),
        }
    }

    pub async fn close(&self) {
        let (rpc, pid) = {
            let mut state = self.state.lock().unwrap();
            state.closing = true;
            (state.rpc.clone(), state.pid)
        };
        let mut exited = self.exited.subscribe();
        if let Some(rpc) = rpc.filter(|_| !*exited.borrow())
            && rpc.request("shutdown", Value::Null, Some(SHUTDOWN_RPC)).await.is_ok()
        {
            rpc.notify("exit", Value::Null);
        }
        let Some(pid) = pid.filter(|_| !*exited.borrow()) else { return };
        signal(pid, false);
        if tokio::time::timeout(KILL_AFTER, exited.wait_for(|e| *e)).await.is_err() {
            signal(pid, true);
            let _ = exited.wait_for(|e| *e).await;
        }
    }

    async fn launch(self: &Arc<Self>, opts: ProcessOptions) -> std::result::Result<(), ()> {
        let spawned = match command(&opts.command) {
            Ok(mut cmd) => {
                cmd.current_dir(&opts.root).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
                spawn_settled(&mut cmd).await.map_err(|e| e.to_string())
            }
            Err(e) => Err(e),
        };
        let mut child = match spawned {
            Ok(child) => child,
            Err(e) => {
                self.exited.send_replace(true);
                return self.fail(format!("cannot start \"{}\": {e}", self.command));
            }
        };
        let (stdin, stdout, stderr) = (child.stdin.take(), child.stdout.take(), child.stderr.take());
        let (Some(stdin), Some(stdout), Some(stderr)) = (stdin, stdout, stderr) else {
            return self.fail(format!("cannot start \"{}\": no stdio", self.command));
        };
        let rpc = Connection::new(stdout, stdin);
        {
            let mut state = self.state.lock().unwrap();
            state.rpc = Some(rpc.clone());
            state.pid = child.id();
        }
        tokio::spawn(child::watch(Arc::downgrade(self), stderr, child));
        self.listen(&rpc);
        let root_uri = url::Url::from_file_path(&opts.root).map(String::from).unwrap_or_default();
        let mut params = json!({
            "processId": std::process::id(),
            "clientInfo": { "name": "diffle" },
            "rootUri": root_uri,
            "rootPath": opts.root.to_string_lossy(),
            "workspaceFolders": [{ "uri": root_uri, "name": "workspace" }],
            "capabilities": client_capabilities(),
        });
        if let Some(options) = opts.initialization_options {
            params["initializationOptions"] = options;
        }
        let init = match rpc.request("initialize", params, Some(INIT_TIMEOUT)).await {
            Ok(init) => init,
            Err(e) => {
                // A server that died says why through its exit, which lands a moment after its output closes.
                if matches!(e, RequestError::Closed(_)) {
                    let mut exited = self.exited.subscribe();
                    let _ = tokio::time::timeout(Duration::from_millis(500), exited.wait_for(|e| *e)).await;
                }
                return self.fail(format!("initialize failed: {e}"));
            }
        };
        let capabilities = init.get("capabilities").cloned().unwrap_or_default();
        let advertised: Vec<LspFeature> =
            all_features().into_iter().filter(|f| capabilities.get(provider_of(*f)).is_some_and(truthy)).collect();
        self.state.lock().unwrap().advertised.extend(advertised);
        rpc.notify("initialized", json!({}));
        let settings = self.state.lock().unwrap().settings.clone();
        if let Some(settings) = settings {
            let settings = settings.await;
            if !self.state.lock().unwrap().closing {
                rpc.notify("workspace/didChangeConfiguration", json!({ "settings": settings }));
            }
        }
        let status = {
            let mut state = self.state.lock().unwrap();
            if state.current.state != LspState::Starting {
                return Err(());
            }
            state.current.state = LspState::Ready;
            state.current.clone()
        };
        (self.on_status)(&status);
        Ok(())
    }

    /// What the output moved lands on the status, unless the process is done.
    fn apply(&self, change: OutputChange) {
        let status = {
            let mut state = self.state.lock().unwrap();
            if state.closing || state.current.state == LspState::Unavailable {
                return;
            }
            match change {
                OutputChange::Log(log) => state.current.log = log,
                OutputChange::Notice(notice) => state.current.notice = Some(notice),
                OutputChange::Activity(activity) => state.current.activity = activity,
            }
            state.current.clone()
        };
        (self.on_status)(&status);
    }

    fn fail(&self, message: String) -> std::result::Result<(), ()> {
        let log = self.output.lock().unwrap().summary();
        let (status, rpc) = {
            let mut state = self.state.lock().unwrap();
            if state.current.state == LspState::Unavailable {
                return Err(());
            }
            state.current = LspProcessStatus {
                name: state.current.name.clone(),
                command: self.command.clone(),
                state: LspState::Unavailable,
                message: Some(message.clone()),
                activity: Vec::new(),
                notice: None,
                log,
            };
            (state.current.clone(), state.rpc.clone())
        };
        if let Some(rpc) = rpc {
            rpc.dispose(message);
        }
        (self.on_status)(&status);
        Err(())
    }
}
