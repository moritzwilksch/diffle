//! JSON-RPC 2.0 with `Content-Length` framing (the LSP base protocol), carrying lsp-types messages.
//! A message that breaks the protocol ends the connection.
use std::collections::HashMap;
use std::fmt;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use futures::FutureExt;
use futures::future::BoxFuture;
use lsp_types::notification::Notification;
use lsp_types::request::Request;
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, watch};

use super::framing::{Broken, encode, message, read_frame};

/// How long a request waits for its answer unless the caller says otherwise.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// JSON-RPC's code for a request the receiver has no handler for.
pub const METHOD_NOT_FOUND: i64 = -32601;
/// JSON-RPC's code for a handler that failed without saying why.
pub const INTERNAL_ERROR: i64 = -32603;
/// LSP `ContentModified`: the document moved under the request, so the answer would be stale.
pub const CONTENT_MODIFIED: i64 = -32801;

/// An error reply, carrying the code so callers can tell a refusal from an outage.
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

/// How a connection ended without diffle ending it.
pub struct Ended {
    pub reason: String,
    /// The server closed its output, as one that exits does: its exit may say more.
    pub hung_up: bool,
}

type Answer = Result<Value, RequestError>;
type OnClose = Box<dyn FnOnce(Ended) + Send>;
type NotificationHandler = Arc<dyn Fn(Value) -> serde_json::Result<()> + Send + Sync>;
type RequestHandler =
    Arc<dyn Fn(Value) -> serde_json::Result<BoxFuture<'static, Result<Value, RpcError>>> + Send + Sync>;

struct Inner {
    next_id: AtomicI64,
    pending: Mutex<HashMap<i64, oneshot::Sender<Answer>>>,
    notifications: Mutex<HashMap<&'static str, NotificationHandler>>,
    requests: Mutex<HashMap<&'static str, RequestHandler>>,
    /// Why the connection ended, once it has.
    closed: watch::Sender<Option<String>>,
    /// Told how the connection ended, unless diffle ended it.
    on_close: Mutex<Option<OnClose>>,
    frames: mpsc::UnboundedSender<Vec<u8>>,
}

/// One end of a connection to a server. Cheap to clone; every clone is the same connection.
#[derive(Clone)]
pub struct Connection {
    inner: Arc<Inner>,
}

impl Connection {
    /// Speaks to the server on the other end of `reader` and `writer`. `on_close` hears how the
    /// connection ended unless `dispose` ended it.
    pub fn new(
        reader: impl AsyncRead + Unpin + Send + 'static,
        writer: impl AsyncWrite + Unpin + Send + 'static,
        on_close: impl FnOnce(Ended) + Send + 'static,
    ) -> Self {
        let (frames, queue) = mpsc::unbounded_channel();
        let inner = Arc::new(Inner {
            next_id: AtomicI64::new(1),
            pending: Mutex::default(),
            notifications: Mutex::default(),
            requests: Mutex::default(),
            closed: watch::channel(None).0,
            on_close: Mutex::new(Some(Box::new(on_close))),
            frames,
        });
        tokio::spawn(write_frames(writer, queue, Arc::downgrade(&inner)));
        tokio::spawn(read_frames(reader, Arc::downgrade(&inner)));
        Self { inner }
    }

    /// Sends a request and waits for its answer. `None` waits 30 seconds; a zero timeout waits
    /// forever. An answer that is not what the protocol says ends the connection.
    pub async fn request<R: Request>(
        &self,
        params: R::Params,
        timeout: Option<Duration>,
    ) -> Result<R::Result, RequestError> {
        let params = serde_json::to_value(params).expect("params serialize");
        let answer = self.call(R::METHOD, params, timeout).await?;
        serde_json::from_value(answer).map_err(|e| {
            end(&self.inner, format!("the language server sent an invalid answer to {}: {e}", R::METHOD), false);
            RequestError::Closed(self.inner.closed.borrow().clone().unwrap_or_default())
        })
    }

    /// Sends a notification, unless the connection is gone.
    pub fn notify<N: Notification>(&self, params: N::Params) {
        let params = serde_json::to_value(params).expect("params serialize");
        send(&self.inner, &message(None, Some(N::METHOD), params));
    }

    /// Answers the server's `R` requests. A handler that panics answers with an error.
    pub fn on_request<R: Request>(
        &self,
        f: impl Fn(R::Params) -> BoxFuture<'static, Result<R::Result, RpcError>> + Send + Sync + 'static,
    ) {
        let handler: RequestHandler = Arc::new(move |params| {
            let answer = f(serde_json::from_value(params)?);
            Ok(async move { answer.await.map(|r| serde_json::to_value(r).expect("results serialize")) }.boxed())
        });
        self.inner.requests.lock().unwrap().insert(R::METHOD, handler);
    }

    /// Hears the server's `N` notifications; any other notification is dropped.
    pub fn on_notification<N: Notification>(&self, f: impl Fn(N::Params) + Send + Sync + 'static) {
        let handler: NotificationHandler = Arc::new(move |params| serde_json::from_value(params).map(&f));
        self.inner.notifications.lock().unwrap().insert(N::METHOD, handler);
    }

    /// Fails every pending request with `reason` and ignores further traffic.
    pub fn dispose(&self, reason: String) {
        self.inner.on_close.lock().unwrap().take();
        end(&self.inner, reason, false);
    }

    async fn call(&self, method: &str, params: Value, timeout: Option<Duration>) -> Answer {
        if let Some(reason) = self.inner.closed.borrow().clone() {
            return Err(RequestError::Closed(reason));
        }
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.inner.pending.lock().unwrap().insert(id, tx);
        send(&self.inner, &message(Some(json!(id)), Some(method), params));
        let answer = async { rx.await.unwrap_or_else(|_| Err(RequestError::Closed("connection closed".into()))) };
        let timeout = timeout.unwrap_or(DEFAULT_TIMEOUT);
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
}

fn send(inner: &Inner, msg: &Value) {
    if inner.closed.borrow().is_some() {
        return;
    }
    let _ = inner.frames.send(encode(msg));
}

/// Ends the connection once: pending requests fail with `reason`, and `on_close` hears it.
fn end(inner: &Inner, reason: String, hung_up: bool) {
    if !inner.closed.send_if_modified(|closed| closed.is_none() && closed.replace(reason.clone()).is_none()) {
        return;
    }
    for (_, tx) in inner.pending.lock().unwrap().drain() {
        let _ = tx.send(Err(RequestError::Closed(reason.clone())));
    }
    // Taken out first: the callback may dispose this very connection.
    let on_close = inner.on_close.lock().unwrap().take();
    if let Some(on_close) = on_close {
        on_close(Ended { reason, hung_up });
    }
}

async fn write_frames(
    mut writer: impl AsyncWrite + Unpin,
    mut queue: mpsc::UnboundedReceiver<Vec<u8>>,
    inner: Weak<Inner>,
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
                end(&inner, format!("cannot write to the language server: {e}"), true);
            }
            return;
        }
    }
}

async fn read_frames(reader: impl AsyncRead + Unpin, inner: Weak<Inner>) {
    let mut reader = BufReader::new(reader);
    let (reason, hung_up) = loop {
        let body = match read_frame(&mut reader).await {
            Ok(Some(body)) => body,
            Ok(None) => break ("the language server closed its output".to_owned(), true),
            Err(Broken::Io(e)) => break (format!("cannot read from the language server: {e}"), true),
            Err(Broken::Protocol(e)) => break (format!("the language server broke the protocol: {e}"), false),
        };
        let Some(inner) = inner.upgrade() else { return };
        if let Err(e) = receive(&inner, &body) {
            break (format!("the language server broke the protocol: {e}"), false);
        }
    };
    if let Some(inner) = inner.upgrade() {
        end(&inner, reason, hung_up);
    }
}

/// Hands one message to its handler or its pending request; an error says how it broke the protocol.
fn receive(inner: &Arc<Inner>, body: &[u8]) -> Result<(), String> {
    let msg: Value = serde_json::from_slice(body).map_err(|e| format!("a message that is not JSON: {e}"))?;
    if inner.closed.borrow().is_some() {
        return Ok(());
    }
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let id = msg.get("id").filter(|id| !id.is_null()).cloned();
    match (msg.get("method").and_then(Value::as_str), id) {
        (Some(method), Some(id)) => {
            let handler = inner.requests.lock().unwrap().get(method).cloned();
            let answer = match handler {
                Some(handler) => handler(params).map_err(|e| format!("{method}: {e}"))?,
                None => {
                    futures::future::ready(Err(RpcError::new(METHOD_NOT_FOUND, format!("no {method} here")))).boxed()
                }
            };
            let weak = Arc::downgrade(inner);
            tokio::spawn(async move {
                let answer = AssertUnwindSafe(answer).catch_unwind().await;
                let answer = answer.unwrap_or_else(|_| Err(RpcError::new(INTERNAL_ERROR, "the handler panicked")));
                let Some(inner) = weak.upgrade() else { return };
                let mut reply = message(Some(id), None, Value::Null);
                match answer {
                    Ok(result) => reply["result"] = result,
                    Err(e) => reply["error"] = json!({ "code": e.code, "message": e.message }),
                }
                send(&inner, &reply);
            });
        }
        (Some(method), None) => {
            let handler = inner.notifications.lock().unwrap().get(method).cloned();
            if let Some(handler) = handler {
                // A panicking handler loses its notification, not the connection.
                if let Ok(parsed) = std::panic::catch_unwind(AssertUnwindSafe(|| handler(params))) {
                    parsed.map_err(|e| format!("{method}: {e}"))?;
                }
            }
        }
        (None, Some(id)) => {
            let id = id.as_i64().ok_or_else(|| format!("a reply to an id diffle never sent: {id}"))?;
            let answer = match msg.get("error") {
                Some(error) if !error.is_null() => {
                    let error: RpcError = serde_json::from_value::<WireError>(error.clone())
                        .map(|e| RpcError::new(e.code, e.message))
                        .map_err(|e| format!("an error reply: {e}"))?;
                    Err(RequestError::Rpc(error))
                }
                _ => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
            };
            if let Some(tx) = inner.pending.lock().unwrap().remove(&id) {
                let _ = tx.send(answer);
            }
        }
        (None, None) => return Err("a message that is neither a request, a reply nor a notification".into()),
    }
    Ok(())
}

#[derive(serde::Deserialize)]
struct WireError {
    code: i64,
    message: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use lsp_types::request::{HoverRequest, WorkspaceConfiguration};
    use lsp_types::{HoverParams, Position, TextDocumentIdentifier, TextDocumentPositionParams, Url};

    fn hover() -> HoverParams {
        let uri = Url::parse("file:///a.py").unwrap();
        HoverParams {
            text_document_position_params: TextDocumentPositionParams {
                text_document: TextDocumentIdentifier { uri },
                position: Position::new(0, 0),
            },
            work_done_progress_params: Default::default(),
        }
    }

    /// A connection to a hand-driven server, the server's ends, and what `on_close` heard.
    fn connect()
    -> (Connection, BufReader<impl AsyncRead + Unpin>, impl AsyncWrite + Unpin, watch::Receiver<Option<String>>) {
        let (a, b) = tokio::io::duplex(4096);
        let (a_read, a_write) = tokio::io::split(a);
        let (b_read, b_write) = tokio::io::split(b);
        let (heard, hear) = watch::channel(None);
        let rpc = Connection::new(a_read, a_write, move |e: Ended| drop(heard.send(Some(e.reason))));
        (rpc, BufReader::new(b_read), b_write, hear)
    }

    async fn frame(w: &mut (impl AsyncWrite + Unpin), body: Value) {
        let body = body.to_string();
        w.write_all(format!("Content-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
    }

    /// The next message diffle sent.
    async fn sent(r: &mut BufReader<impl AsyncRead + Unpin>) -> Value {
        let Ok(Some(body)) = read_frame(r).await else { panic!("no frame") };
        serde_json::from_slice(&body).unwrap()
    }

    #[tokio::test]
    async fn asks_and_answers_typed_messages_and_times_out() {
        let (rpc, mut read, mut write, _) = connect();
        rpc.on_request::<WorkspaceConfiguration>(|params| {
            async move { Ok(params.items.iter().map(|i| json!(i.section)).collect()) }.boxed()
        });
        let err = rpc.request::<HoverRequest>(hover(), Some(Duration::from_millis(50))).await.unwrap_err();
        assert_eq!(err.to_string(), "textDocument/hover timed out after 50 ms");
        let late = sent(&mut read).await;
        let asked = tokio::spawn({
            let rpc = rpc.clone();
            async move { rpc.request::<HoverRequest>(hover(), None).await }
        });
        let ask = sent(&mut read).await;
        assert_eq!(
            (ask["method"].as_str(), &ask["params"]["position"]),
            (Some("textDocument/hover"), &json!({ "line": 0, "character": 0 }))
        );
        // A late reply to a request that timed out is dropped.
        frame(&mut write, json!({ "jsonrpc": "2.0", "id": late["id"], "result": null })).await;
        frame(&mut write, json!({ "jsonrpc": "2.0", "id": ask["id"], "result": { "contents": "hi" } })).await;
        assert!(asked.await.unwrap().unwrap().is_some());

        frame(&mut write, json!({ "jsonrpc": "2.0", "id": 7, "method": "workspace/configuration", "params": { "items": [{ "section": "a" }, {}] } })).await;
        assert_eq!(sent(&mut read).await, json!({ "jsonrpc": "2.0", "id": 7, "result": ["a", null] }));
        frame(&mut write, json!({ "jsonrpc": "2.0", "id": "x", "method": "window/showDocument", "params": {} })).await;
        let refused = sent(&mut read).await;
        assert_eq!((&refused["id"], &refused["error"]["code"]), (&json!("x"), &json!(METHOD_NOT_FOUND)));
    }

    #[tokio::test]
    async fn ends_on_an_invalid_answer_or_frame_but_not_on_dispose() {
        let (rpc, mut read, mut write, mut hear) = connect();
        let asked = tokio::spawn({
            let rpc = rpc.clone();
            async move { rpc.request::<HoverRequest>(hover(), None).await }
        });
        let ask = sent(&mut read).await;
        frame(&mut write, json!({ "jsonrpc": "2.0", "id": ask["id"], "result": { "contents": 7 } })).await;
        let Err(RequestError::Closed(reason)) = asked.await.unwrap() else { panic!("the answer was accepted") };
        assert!(reason.starts_with("the language server sent an invalid answer to textDocument/hover: "), "{reason}");
        hear.wait_for(Option::is_some).await.unwrap();
        assert_eq!(hear.borrow().as_deref(), Some(reason.as_str()));

        let (rpc, _read, mut write, mut hear) = connect();
        write.write_all(b"X-Junk: 1\r\n\r\n").await.unwrap();
        hear.wait_for(Option::is_some).await.unwrap();
        let reason = hear.borrow().clone().unwrap();
        assert_eq!(reason, "the language server broke the protocol: a frame without Content-Length");
        assert!(
            matches!(rpc.request::<HoverRequest>(hover(), None).await, Err(RequestError::Closed(r)) if r == reason)
        );

        let (rpc, _read, _write, hear) = connect();
        rpc.dispose("done".into());
        assert!(
            matches!(rpc.request::<HoverRequest>(hover(), None).await, Err(RequestError::Closed(r)) if r == "done")
        );
        assert!(hear.borrow().is_none());
    }
}
