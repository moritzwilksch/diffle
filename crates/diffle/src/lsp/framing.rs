//! The LSP base protocol on the wire: JSON-RPC messages behind `Content-Length` headers. A frame
//! that is not framed so is refused, never skipped.
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt};

/// A request (an id and a method), a notification (a method alone), or a reply (an id alone).
pub fn message(id: Option<Value>, method: Option<&str>, params: Value) -> Value {
    let mut msg = json!({ "jsonrpc": "2.0" });
    if let Some(id) = id {
        msg["id"] = id;
    }
    if let Some(method) = method {
        msg["method"] = json!(method);
    }
    if !params.is_null() {
        msg["params"] = params;
    }
    msg
}

/// `msg` as one frame.
pub fn encode(msg: &Value) -> Vec<u8> {
    let body = serde_json::to_vec(msg).expect("messages serialize");
    let mut frame = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    frame.extend(body);
    frame
}

/// Why a frame could not be read: the stream failed, or the server broke the framing.
pub enum Broken {
    Io(std::io::Error),
    Protocol(String),
}

/// One frame's body; none once the server closed its output between frames.
pub async fn read_frame(reader: &mut (impl AsyncBufReadExt + Unpin)) -> Result<Option<Vec<u8>>, Broken> {
    let mut length = None;
    let mut first = true;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).await.map_err(Broken::Io)? == 0 {
            return if first { Ok(None) } else { Err(Broken::Protocol("a frame cut off in its header".into())) };
        }
        first = false;
        let Some(line) = line.strip_suffix("\r\n") else {
            return Err(Broken::Protocol(format!("a header line without CRLF: {line:?}")));
        };
        if line.is_empty() {
            break;
        }
        let Some((name, value)) = line.split_once(": ") else {
            return Err(Broken::Protocol(format!("not a header: {line:?}")));
        };
        if name.eq_ignore_ascii_case("content-length") {
            length = Some(value.parse::<usize>().map_err(|_| Broken::Protocol(format!("a bad length: {value:?}")))?);
        }
    }
    let length = length.ok_or_else(|| Broken::Protocol("a frame without Content-Length".into()))?;
    let mut body = vec![0; length];
    reader.read_exact(&mut body).await.map_err(Broken::Io)?;
    Ok(Some(body))
}
