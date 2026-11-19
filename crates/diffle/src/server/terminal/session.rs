//! A PTY and bounded scrollback owned by the run. Browser sockets only attach to it.
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::ws::Message;
use portable_pty::PtySize;
use tokio::sync::{broadcast, mpsc, watch};

use super::pty;
use crate::protocol::TerminalStatus;

const REPLAY_BYTES: usize = 512 * 1024;

pub(super) enum Input {
    Bytes(Bytes),
    Resize(PtySize),
}

#[derive(Default)]
struct Scrollback {
    chunks: VecDeque<Bytes>,
    bytes: usize,
    status: Option<Message>,
}

pub(super) struct Pane {
    pub input: mpsc::Sender<Input>,
    pub closed: watch::Sender<bool>,
    history: Mutex<Scrollback>,
    live: broadcast::Sender<Message>,
}

impl Pane {
    pub fn start(dir: PathBuf, size: PtySize, command: Option<String>, shutdown: watch::Receiver<bool>) -> Arc<Self> {
        let (input, commands) = mpsc::channel(64);
        let (closed, _) = watch::channel(false);
        let (live, _) = broadcast::channel(128);
        let pane = Arc::new(Self { input, closed, history: Mutex::default(), live });
        tokio::spawn(pane.clone().run(dir, size, command, commands, shutdown));
        pane
    }

    /// The initial replay and live receiver share a boundary: no output may fall between them.
    pub fn subscribe(&self) -> (Vec<Message>, broadcast::Receiver<Message>) {
        let history = self.history.lock().unwrap();
        let replay = history.chunks.iter().cloned().map(Message::Binary).chain(history.status.clone()).collect();
        (replay, self.live.subscribe())
    }

    fn output(&self, bytes: Bytes) {
        let mut history = self.history.lock().unwrap();
        history.bytes += bytes.len();
        history.chunks.push_back(bytes.clone());
        while history.bytes > REPLAY_BYTES {
            let dropped = history.chunks.pop_front().unwrap();
            history.bytes -= dropped.len();
        }
        let _ = self.live.send(Message::Binary(bytes));
    }

    fn finish(&self, error: Option<String>, exit_code: Option<i64>) {
        let text = serde_json::to_string(&TerminalStatus { error, exit_code }).expect("terminal status serializes");
        let status = Message::Text(text.into());
        let mut history = self.history.lock().unwrap();
        history.status = Some(status.clone());
        let _ = self.live.send(status);
    }

    async fn run(
        self: Arc<Self>,
        dir: PathBuf,
        size: PtySize,
        command: Option<String>,
        mut commands: mpsc::Receiver<Input>,
        mut shutdown: watch::Receiver<bool>,
    ) {
        let mut closed = self.closed.subscribe();
        let opened = tokio::task::spawn_blocking(move || pty::Terminal::open(&dir, size, command.as_deref())).await;
        let mut terminal = match opened {
            Ok(Ok(terminal)) => terminal,
            Ok(Err(error)) => return self.finish(Some(error.to_string()), None),
            Err(error) => return self.finish(Some(error.to_string()), None),
        };
        loop {
            tokio::select! {
                _ = async { drop(closed.wait_for(|closed| *closed).await) } => break,
                _ = async { drop(shutdown.wait_for(|stopped| *stopped).await) } => break,
                output = terminal.output.recv() => {
                    let Some(output) = output else {
                        let exit = tokio::time::timeout(Duration::from_secs(1), terminal.wait()).await.ok().flatten();
                        self.finish(None, exit);
                        break;
                    };
                    self.output(output.into());
                }
                input = commands.recv() => match input {
                    Some(Input::Bytes(bytes)) => {
                        if !matches!(tokio::time::timeout(Duration::from_secs(1), terminal.input.send(bytes)).await, Ok(Ok(()))) {
                            self.finish(Some("Terminal input stalled".into()), None);
                            break;
                        }
                    }
                    Some(Input::Resize(size)) => {
                        if terminal.master.resize(size).is_err() { break }
                    }
                    None => break,
                },
            }
        }
        if self.history.lock().unwrap().status.is_none() {
            self.finish(None, None);
        }
    }
}
