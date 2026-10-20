//! The broadcast hub on `/ws`: server → client only.
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::extract::ws::{Message, WebSocket};
use tokio::sync::{broadcast, watch};

use crate::protocol::ServerMessage;
use crate::session::Broadcaster;

/// Clients send nothing; anything larger than a ping is not a client.
pub const MAX_PAYLOAD_BYTES: usize = 4096;
/// Messages a slow client may fall behind by; one that lags further is caught up by the next one.
const BACKLOG: usize = 256;

pub struct Hub {
    messages: broadcast::Sender<String>,
    /// Set once the server closes: every client is let go.
    closing: watch::Sender<bool>,
    count: AtomicUsize,
    clients: watch::Sender<usize>,
}

impl Hub {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            messages: broadcast::channel(BACKLOG).0,
            closing: watch::channel(false).0,
            count: AtomicUsize::new(0),
            clients: watch::channel(0).0,
        })
    }

    pub fn client_count(&self) -> usize {
        self.count.load(Ordering::SeqCst)
    }

    /// Every change of the number of connected clients.
    pub fn clients(&self) -> watch::Receiver<usize> {
        self.clients.subscribe()
    }

    fn counted(&self, delta: isize) {
        let count = if delta > 0 {
            self.count.fetch_add(1, Ordering::SeqCst) + 1
        } else {
            self.count.fetch_sub(1, Ordering::SeqCst) - 1
        };
        self.clients.send_replace(count);
    }

    /// Ends every client connection, now and for any that connect later.
    pub fn close(&self) {
        self.closing.send_replace(true);
    }

    /// Serves one upgraded client until it or the server goes away.
    pub async fn serve(self: Arc<Self>, mut socket: WebSocket) {
        let mut messages = self.messages.subscribe();
        let mut closing = self.closing.subscribe();
        self.counted(1);
        loop {
            tokio::select! {
                () = async { drop(closing.wait_for(|closed| *closed).await) } => break,
                message = messages.recv() => match message {
                    Ok(text) => {
                        if socket.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    // A client that fell behind refetches on the next invalidation anyway.
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => break,
                },
                incoming = socket.recv() => match incoming {
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => {}
                },
            }
        }
        self.counted(-1);
    }
}

impl Broadcaster for Hub {
    fn broadcast(&self, msg: ServerMessage) {
        let text = serde_json::to_string(&msg).expect("server messages serialize");
        // No receivers just means no clients.
        let _ = self.messages.send(text);
    }
}
