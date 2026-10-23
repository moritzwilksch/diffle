//! The client build, embedded in release builds and read from `crates/diffle/client` in debug ones.
//! Build it (`npm run build`) before a release build; a published crate carries it.
use axum::extract::Request;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};

#[derive(rust_embed::Embed)]
#[folder = "$CARGO_MANIFEST_DIR/client"]
// A checkout without a client build still compiles and tests; serving then says how to build it.
#[allow_missing = true]
struct Client;

/// The asset at the request path, else `index.html`: the client routes everything else itself.
pub async fn serve(req: Request) -> Response {
    let path = req.uri().path().trim_start_matches('/');
    let (name, file) = match Client::get(path) {
        Some(file) if !path.is_empty() => (path, file),
        _ => match Client::get("index.html") {
            Some(file) => ("index.html", file),
            None => {
                let missing = "the client is not built; run `npm run build`";
                return (StatusCode::NOT_FOUND, missing).into_response();
            }
        },
    };
    let mime = mime_guess::from_path(name).first_or_octet_stream();
    ([(header::CONTENT_TYPE, mime.as_ref().to_owned())], file.data).into_response()
}
