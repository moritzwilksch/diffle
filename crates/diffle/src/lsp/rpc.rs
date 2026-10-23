//! The connection to one server: async-lsp's main loop over its stdio, asked through the typed
//! `LanguageServer` calls. A message that breaks the protocol ends the connection.
use std::fmt;
use std::ops::ControlFlow;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_lsp::panic::CatchUnwindLayer;
use async_lsp::router::Router;
use async_lsp::{MainLoop, ResponseError, ServerSocket};
use futures::future::BoxFuture;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::watch;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};
use tower_layer::Layer;

/// How long a request waits for its answer unless the caller says otherwise.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Why a request got no result: the server refused it, the connection is gone, or time ran out.
#[derive(Debug, Clone)]
pub enum RequestError {
    Rpc(ResponseError),
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

type OnClose = Box<dyn FnOnce(Ended) + Send>;

struct Shared {
    /// Why the connection ended, once it has.
    closed: watch::Sender<Option<String>>,
    /// Told why the connection ended, unless diffle ended it.
    on_close: Mutex<Option<OnClose>>,
}

impl Shared {
    fn reason(&self) -> Option<String> {
        self.closed.borrow().clone()
    }

    fn end(&self, server: &ServerSocket, reason: String) {
        self.closed.send_if_modified(|closed| closed.is_none() && closed.replace(reason).is_none());
        let _ = server.emit(Stop);
    }
}

/// Ends the main loop from diffle's side.
struct Stop;

/// One end of a connection to a server. Cheap to clone; every clone is the same connection.
#[derive(Clone)]
pub struct Connection {
    server: ServerSocket,
    shared: Arc<Shared>,
}

impl Connection {
    /// Serves `router` to the server on the other end of `reader` and `writer`. A panicking handler
    /// answers with an error. `on_close` hears why the connection ended unless `dispose` ended it.
    pub fn new<St: Send + 'static>(
        reader: impl AsyncRead + Unpin + Send + 'static,
        writer: impl AsyncWrite + Unpin + Send + 'static,
        mut router: Router<St>,
        on_close: impl FnOnce(Ended) + Send + 'static,
    ) -> Self {
        router.event::<Stop>(|_, _| ControlFlow::Break(Ok(())));
        let shared =
            Arc::new(Shared { closed: watch::channel(None).0, on_close: Mutex::new(Some(Box::new(on_close))) });
        let (main, server) = MainLoop::new_client(|_| CatchUnwindLayer::default().layer(router));
        let ended = shared.clone();
        tokio::spawn(async move {
            let result = main.run_buffered(reader.compat(), writer.compat_write()).await;
            let hung_up = matches!(result, Err(async_lsp::Error::Eof));
            let reason = match result {
                Ok(()) => "connection closed".to_owned(),
                Err(async_lsp::Error::Eof) => "the language server closed its output".to_owned(),
                Err(e) => format!("the language server broke the protocol: {e}"),
            };
            ended.closed.send_if_modified(|closed| closed.is_none() && closed.replace(reason).is_none());
            let on_close = ended.on_close.lock().unwrap().take();
            if let (Some(on_close), Some(reason)) = (on_close, ended.reason()) {
                on_close(Ended { reason, hung_up });
            }
        });
        Self { server, shared }
    }

    /// Waits for the answer to `call`, a `LanguageServer` request. `None` waits 30 seconds; a zero
    /// timeout waits forever. An answer that is not what the protocol says ends the connection.
    pub async fn ask<T>(
        &self,
        call: impl FnOnce(&mut ServerSocket) -> BoxFuture<'static, async_lsp::Result<T>>,
        timeout: Option<Duration>,
    ) -> Result<T, RequestError> {
        if let Some(reason) = self.shared.reason() {
            return Err(RequestError::Closed(reason));
        }
        let answer = call(&mut self.server.clone());
        let answer = async {
            match answer.await {
                Ok(result) => Ok(result),
                Err(async_lsp::Error::Response(e)) => Err(RequestError::Rpc(e)),
                Err(async_lsp::Error::Deserialize(e)) => {
                    self.shared.end(&self.server, format!("the language server sent an invalid answer: {e}"));
                    Err(RequestError::Closed(self.shared.reason().unwrap_or_default()))
                }
                Err(_) => {
                    // The loop drops its pending requests on the way out, a moment before it says why.
                    let mut closed = self.shared.closed.subscribe();
                    let reason = closed.wait_for(Option::is_some).await.ok().and_then(|r| r.clone());
                    Err(RequestError::Closed(reason.unwrap_or_else(|| "connection closed".into())))
                }
            }
        };
        let timeout = timeout.unwrap_or(DEFAULT_TIMEOUT);
        if timeout.is_zero() {
            return answer.await;
        }
        tokio::time::timeout(timeout, answer)
            .await
            .unwrap_or_else(|_| Err(RequestError::Timeout(format!("no answer within {} ms", timeout.as_millis()))))
    }

    /// Sends a `LanguageServer` notification, unless the connection is gone.
    pub fn notify(&self, send: impl FnOnce(&mut ServerSocket) -> async_lsp::Result<()>) {
        if self.shared.reason().is_none() {
            let _ = send(&mut self.server.clone());
        }
    }

    /// Fails every pending request with `reason` and ignores further traffic.
    pub fn dispose(&self, reason: String) {
        self.shared.on_close.lock().unwrap().take();
        self.shared.end(&self.server, reason);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_lsp::LanguageServer;
    use async_lsp::lsp_types::{HoverParams, Position, TextDocumentIdentifier, TextDocumentPositionParams, Url};
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

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

    /// A connection to a hand-driven server, and what `on_close` heard.
    fn connect() -> (Connection, impl AsyncRead + Unpin, impl AsyncWrite + Unpin, watch::Receiver<Option<String>>) {
        let (a, b) = tokio::io::duplex(4096);
        let (a_read, a_write) = tokio::io::split(a);
        let (b_read, b_write) = tokio::io::split(b);
        let (heard, hear) = watch::channel(None);
        let rpc = Connection::new(a_read, a_write, Router::new(()), move |e: Ended| drop(heard.send(Some(e.reason))));
        (rpc, b_read, b_write, hear)
    }

    async fn frame(w: &mut (impl AsyncWrite + Unpin), body: &str) {
        w.write_all(format!("Content-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
    }

    /// Reads one request's frame off the wire, for its id.
    async fn request_id(r: &mut BufReader<impl AsyncRead + Unpin>) -> i64 {
        let mut length = 0;
        loop {
            let mut line = String::new();
            r.read_line(&mut line).await.unwrap();
            if line == "\r\n" {
                break;
            }
            if let Some(n) = line.strip_prefix("Content-Length: ") {
                length = n.trim().parse().unwrap();
            }
        }
        let mut body = vec![0; length];
        r.read_exact(&mut body).await.unwrap();
        serde_json::from_slice::<serde_json::Value>(&body).unwrap()["id"].as_i64().unwrap()
    }

    #[tokio::test]
    async fn answers_and_times_out_and_ends_on_an_invalid_answer() {
        let (rpc, read, mut write, mut hear) = connect();
        let mut read = BufReader::new(read);
        let err = rpc.ask(|s| s.hover(hover()), Some(Duration::from_millis(50))).await.unwrap_err();
        assert_eq!(err.to_string(), "no answer within 50 ms");
        let first = request_id(&mut read).await;
        let asked = tokio::spawn({
            let rpc = rpc.clone();
            async move { rpc.ask(|s| s.hover(hover()), None).await }
        });
        let id = request_id(&mut read).await;
        frame(&mut write, &format!(r#"{{"jsonrpc":"2.0","id":{first},"result":null}}"#)).await;
        frame(&mut write, &format!(r#"{{"jsonrpc":"2.0","id":{id},"result":{{"contents":7}}}}"#)).await;
        let Err(RequestError::Closed(reason)) = asked.await.unwrap() else { panic!("the answer was accepted") };
        assert!(reason.starts_with("the language server sent an invalid answer: "), "{reason}");
        hear.wait_for(Option::is_some).await.unwrap();
        assert_eq!(hear.borrow().as_deref(), Some(reason.as_str()));
    }

    #[tokio::test]
    async fn ends_on_a_frame_without_length_and_not_on_dispose() {
        let (rpc, _read, mut write, mut hear) = connect();
        write.write_all(b"X-Junk: 1\r\n\r\n").await.unwrap();
        hear.wait_for(Option::is_some).await.unwrap();
        let reason = hear.borrow().clone().unwrap();
        assert_eq!(reason, "the language server broke the protocol: protocol error: Missing content-length");
        assert!(matches!(rpc.ask(|s| s.hover(hover()), None).await, Err(RequestError::Closed(r)) if r == reason));

        let (rpc, _read, _write, hear) = connect();
        rpc.dispose("done".into());
        assert!(matches!(rpc.ask(|s| s.hover(hover()), None).await, Err(RequestError::Closed(r)) if r == "done"));
        tokio::task::yield_now().await;
        assert!(hear.borrow().is_none());
    }
}
