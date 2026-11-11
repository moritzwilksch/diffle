//! The client build, embedded in release builds and read from `crates/diffle/client` in debug ones.
//! Build it (`npm run build`) before a release build; a published crate carries it.
use std::io::Read;

use axum::extract::Request;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use rust_embed::EmbeddedFile;

#[derive(rust_embed::Embed)]
#[folder = "$CARGO_MANIFEST_DIR/client"]
// A checkout without a client build still compiles and tests; serving then says how to build it.
#[allow_missing = true]
struct Client;

/// The asset at the request path, else `index.html`: the client routes everything else itself.
/// Text assets are stored gzipped (`x.js.gz`) and sent encoded to a client that accepts gzip.
pub async fn serve(req: Request) -> Response {
    let path = req.uri().path().trim_start_matches('/');
    let (name, (file, gzipped)) = match find(path) {
        Some(found) if !path.is_empty() => (path, found),
        _ => match find("index.html") {
            Some(found) => ("index.html", found),
            None => {
                let missing = "the client is not built; run `npm run build`";
                return (StatusCode::NOT_FOUND, missing).into_response();
            }
        },
    };
    let mime = mime_guess::from_path(name).first_or_octet_stream();
    let mut res = if !gzipped {
        file.data.into_response()
    } else if accepts_gzip(req.headers()) {
        let mut res = file.data.into_response();
        res.headers_mut().insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
        res
    } else {
        let mut plain = Vec::new();
        if let Err(e) = flate2::read::GzDecoder::new(&file.data[..]).read_to_end(&mut plain) {
            return (StatusCode::INTERNAL_SERVER_ERROR, format!("{name}: {e}")).into_response();
        }
        plain.into_response()
    };
    let headers = res.headers_mut();
    if let Ok(mime) = HeaderValue::from_str(mime.as_ref()) {
        headers.insert(header::CONTENT_TYPE, mime);
    }
    if gzipped {
        headers.insert(header::VARY, HeaderValue::from_static("accept-encoding"));
    }
    // Vite names every file under `assets/` by its content hash; `index.html` names the current ones.
    let cache = if name.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    res
}

/// The embedded file for `name` and whether it is the gzipped copy.
fn find(name: &str) -> Option<(EmbeddedFile, bool)> {
    Client::get(&format!("{name}.gz")).map(|f| (f, true)).or_else(|| Client::get(name).map(|f| (f, false)))
}

/// Whether `Accept-Encoding` lists gzip (or `*`) without `q=0`.
fn accepts_gzip(headers: &HeaderMap) -> bool {
    headers.get_all(header::ACCEPT_ENCODING).iter().filter_map(|v| v.to_str().ok()).flat_map(|v| v.split(',')).any(
        |coding| {
            let mut parts = coding.split(';').map(str::trim);
            let name = parts.next().unwrap_or_default();
            let refused =
                parts.any(|p| p.strip_prefix("q=").and_then(|q| q.parse::<f32>().ok()).is_some_and(|q| q == 0.0));
            (name.eq_ignore_ascii_case("gzip") || name == "*") && !refused
        },
    )
}
