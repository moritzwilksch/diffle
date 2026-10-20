//! JSON-RPC 2.0 over a byte stream with `Content-Length` framing (the LSP base protocol). No LSP semantics.
use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::future::BoxFuture;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

/// How long a request waits for its answer unless the caller says otherwise.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// A server's error reply, carrying the code so callers can tell a refusal from an outage.
#[derive(Debug, Clone)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

/// Why a request got no result: the server refused it, the connection is gone, or time ran out.
#[derive(Debug, Clone)]
pub enum RequestError {
    Rpc(RpcError),
    Closed(String),
    Timeout(String),
}

impl fmt::Display for RequestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Rpc(e) => f.write_str(&e.message),
            Self::Closed(reason) | Self::Timeout(reason) => f.write_str(reason),
        }
    }
}

impl std::error::Error for RequestError {}

type Answer = Result<Value, RequestError>;
type MessageHandler = Arc<dyn Fn(&str, &Value) + Send + Sync>;
type RequestHandler = Arc<dyn Fn(Value) -> BoxFuture<'static, Result<Value, RpcError>> + Send + Sync>;

struct Inner {
    next_id: AtomicI64,
    pending: Mutex<HashMap<i64, oneshot::Sender<Answer>>>,
    handlers: Mutex<Vec<MessageHandler>>,
    requests: Mutex<HashMap<String, RequestHandler>>,
    disposed: Mutex<Option<String>>,
    frames: mpsc::UnboundedSender<Vec<u8>>,
}

/// One end of a JSON-RPC connection. Cheap to clone; every clone is the same connection.
#[derive(Clone)]
pub struct Connection {
    inner: Arc<Inner>,
}

impl Connection {
    pub fn new(
        reader: impl AsyncRead + Unpin + Send + 'static,
        writer: impl AsyncWrite + Unpin + Send + 'static,
    ) -> Self {
        let (frames, queue) = mpsc::unbounded_channel();
        let inner = Arc::new(Inner {
            next_id: AtomicI64::new(1),
            pending: Mutex::new(HashMap::new()),
            handlers: Mutex::new(Vec::new()),
            requests: Mutex::new(HashMap::new()),
            disposed: Mutex::new(None),
            frames,
        });
        let conn = Self { inner };
        tokio::spawn(write_frames(writer, queue, Arc::downgrade(&conn.inner)));
        tokio::spawn(read_frames(reader, Arc::downgrade(&conn.inner)));
        conn
    }

    /// Sends a request and waits for its result. `None` waits 30 seconds; a zero timeout waits forever.
    pub async fn request(&self, method: &str, params: Value, timeout: Option<Duration>) -> Answer {
        if let Some(reason) = self.inner.disposed.lock().unwrap().clone() {
            return Err(RequestError::Closed(reason));
        }
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.inner.pending.lock().unwrap().insert(id, tx);
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        let timeout = timeout.unwrap_or(DEFAULT_TIMEOUT);
        let answer = async { rx.await.unwrap_or_else(|_| Err(RequestError::Closed("connection closed".into()))) };
        if timeout.is_zero() {
            return answer.await;
        }
        match tokio::time::timeout(timeout, answer).await {
            Ok(answer) => answer,
            Err(_) => {
                self.inner.pending.lock().unwrap().remove(&id);
                Err(RequestError::Timeout(format!("{method} timed out after {} ms", timeout.as_millis())))
            }
        }
    }

    pub fn notify(&self, method: &str, params: Value) {
        if self.inner.disposed.lock().unwrap().is_some() {
            return;
        }
        self.send(&json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }

    /// Observes every message the server sends: notifications and requests alike.
    pub fn on_message(&self, f: impl Fn(&str, &Value) + Send + Sync + 'static) {
        self.inner.handlers.lock().unwrap().push(Arc::new(f));
    }

    /// Handles a server request and answers with its result, or its error.
    pub fn on_request(
        &self,
        method: &str,
        f: impl Fn(Value) -> BoxFuture<'static, Result<Value, RpcError>> + Send + Sync + 'static,
    ) {
        self.inner.requests.lock().unwrap().insert(method.to_owned(), Arc::new(f));
    }

    /// Fails every pending request with `reason` and ignores further traffic.
    pub fn dispose(&self, reason: String) {
        dispose(&self.inner, reason);
    }

    fn send(&self, msg: &Value) {
        send(&self.inner, msg);
    }
}

fn send(inner: &Inner, msg: &Value) {
    if inner.disposed.lock().unwrap().is_some() {
        return;
    }
    let body = serde_json::to_vec(msg).expect("messages serialize");
    let mut frame = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    frame.extend(body);
    let _ = inner.frames.send(frame);
}

fn dispose(inner: &Inner, reason: String) {
    let mut disposed = inner.disposed.lock().unwrap();
    if disposed.is_some() {
        return;
    }
    *disposed = Some(reason.clone());
    drop(disposed);
    for (_, tx) in inner.pending.lock().unwrap().drain() {
        let _ = tx.send(Err(RequestError::Closed(reason.clone())));
    }
}

async fn write_frames(
    mut writer: impl AsyncWrite + Unpin,
    mut queue: mpsc::UnboundedReceiver<Vec<u8>>,
    inner: std::sync::Weak<Inner>,
) {
    while let Some(frame) = queue.recv().await {
        // A server that dies mid-request turns the next write into EPIPE: the connection is over.
        if let Err(e) = async {
            writer.write_all(&frame).await?;
            writer.flush().await
        }
        .await
        {
            if let Some(inner) = inner.upgrade() {
                dispose(&inner, format!("cannot write to the language server: {e}"));
            }
            return;
        }
    }
}

async fn read_frames(reader: impl AsyncRead + Unpin, inner: std::sync::Weak<Inner>) {
    let mut reader = BufReader::new(reader);
    let reason = loop {
        let mut length: Option<usize> = None;
        let mut saw_header = false;
        // Header lines up to the blank one; an unparseable frame is dropped and the next one read.
        loop {
            let mut line = Vec::new();
            match reader.read_until(b'\n', &mut line).await {
                Ok(0) => return closed(&inner, "the language server closed its output"),
                Ok(_) => {}
                Err(e) => return closed(&inner, &format!("cannot read from the language server: {e}")),
            }
            let text = String::from_utf8_lossy(&line);
            let text = text.trim_end_matches(['\r', '\n']);
            if text.is_empty() {
                if saw_header {
                    break;
                }
                continue;
            }
            saw_header = true;
            if let Some((name, value)) = text.split_once(':')
                && name.trim().eq_ignore_ascii_case("content-length")
            {
                length = value.trim().parse().ok();
            }
        }
        let Some(length) = length else { continue };
        let mut body = vec![0; length];
        if let Err(e) = reader.read_exact(&mut body).await {
            break format!("cannot read from the language server: {e}");
        }
        let Some(inner) = inner.upgrade() else { return };
        receive(&inner, &body);
    };
    closed(&inner, &reason);
}

fn closed(inner: &std::sync::Weak<Inner>, reason: &str) {
    if let Some(inner) = inner.upgrade() {
        dispose(&inner, reason.to_owned());
    }
}

fn receive(inner: &Arc<Inner>, body: &[u8]) {
    let Ok(msg) = serde_json::from_slice::<Value>(body) else { return };
    if inner.disposed.lock().unwrap().is_some() {
        return;
    }
    if let Some(method) = msg.get("method").and_then(Value::as_str) {
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        let handlers: Vec<MessageHandler> = inner.handlers.lock().unwrap().clone();
        for handler in handlers {
            handler(method, &params);
        }
        let Some(id) = msg.get("id").filter(|id| !id.is_null()).cloned() else { return };
        let handler = inner.requests.lock().unwrap().get(method).cloned();
        let weak = Arc::downgrade(inner);
        tokio::spawn(async move {
            let result = match handler {
                Some(handler) => handler(params).await,
                None => Ok(Value::Null),
            };
            let Some(inner) = weak.upgrade() else { return };
            let reply = match result {
                Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": e.code, "message": e.message } }),
            };
            send(&inner, &reply);
        });
        return;
    }
    let Some(id) = msg.get("id").and_then(Value::as_i64) else { return };
    let Some(tx) = inner.pending.lock().unwrap().remove(&id) else { return };
    let answer = match msg.get("error") {
        Some(error) if !error.is_null() => Err(RequestError::Rpc(RpcError {
            code: error.get("code").and_then(Value::as_i64).unwrap_or(-32603),
            message: error.get("message").and_then(Value::as_str).unwrap_or("Request failed").to_owned(),
        })),
        _ => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
    };
    let _ = tx.send(answer);
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::FutureExt;

    #[tokio::test]
    async fn answers_asynchronous_server_requests_and_returns_handler_errors_without_losing_the_connection() {
        let (a, b) = tokio::io::duplex(4096);
        let (a_read, a_write) = tokio::io::split(a);
        let (b_read, b_write) = tokio::io::split(b);
        let client = Connection::new(a_read, a_write);
        let server = Connection::new(b_read, b_write);
        client.on_request("workspace/configuration", |_| {
            async {
                tokio::task::yield_now().await;
                Ok(json!([{ "hover": true }, null]))
            }
            .boxed()
        });
        client.on_request("fail", |_| async { Err(RpcError::new(-32602, "bad parameters")) }.boxed());
        let config = server.request("workspace/configuration", json!({}), None).await.unwrap();
        assert_eq!(config, json!([{ "hover": true }, null]));
        match server.request("fail", json!({}), None).await {
            Err(RequestError::Rpc(e)) => assert_eq!((e.code, e.message.as_str()), (-32602, "bad parameters")),
            other => panic!("{other:?}"),
        }
        assert_eq!(server.request("window/workDoneProgress/create", json!({}), None).await.unwrap(), Value::Null);
        client.dispose("done".into());
        assert!(matches!(client.request("x", json!({}), None).await, Err(RequestError::Closed(r)) if r == "done"));
        server.dispose("done".into());
    }

    #[tokio::test]
    async fn resyncs_after_a_frame_without_length_and_times_out_unanswered_requests() {
        let (a, b) = tokio::io::duplex(4096);
        let (a_read, a_write) = tokio::io::split(a);
        let (mut b_read, mut b_write) = tokio::io::split(b);
        let client = Connection::new(a_read, a_write);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let record = seen.clone();
        client.on_message(move |method, _| record.lock().unwrap().push(method.to_owned()));
        let body = br#"{"jsonrpc":"2.0","method":"hello","params":{}}"#;
        b_write.write_all(b"X-Junk: 1\r\n\r\n").await.unwrap();
        b_write.write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes()).await.unwrap();
        b_write.write_all(body).await.unwrap();
        let err = client.request("slow", json!(null), Some(Duration::from_millis(50))).await.unwrap_err();
        assert_eq!(err.to_string(), "slow timed out after 50 ms");
        assert_eq!(*seen.lock().unwrap(), ["hello"]);
        let mut sent = vec![0; 16];
        assert!(b_read.read(&mut sent).await.unwrap() > 0);
    }
}
