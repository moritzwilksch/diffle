//! One language server as diffle asks it: requests against synced documents, answers in snapshot paths.
use std::collections::HashSet;
use std::num::NonZeroU64;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};

use super::documents::{Documents, ReadFn};
use super::hover::{hover_markdown, localize_file_links};
use super::locator::{HasFn, Locator};
use super::process::{LspProcess, ProcessOptions, SettingsFuture};
use super::rpc::RequestError;
use super::shapes::{Range, flatten_symbols, from_lsp, normalize_locations, symbol_information, to_lsp};
use crate::error::{Error, Result};
use crate::protocol::{
    LspFeature, LspHoverResponse, LspHoverResponseRange, LspLocationsResponse, LspLogEntry, LspOccurrence,
    LspOccurrenceKind, LspOccurrencesResponse, LspPosition, LspProcessStatus, LspSymbolsResponse, feature_label,
};

/// LSP `ContentModified`: the document moved under the request, so the answer would be stale.
const CONTENT_MODIFIED: i64 = -32801;
/// Waits before re-asking a request the server refused as stale, one per attempt.
const CONTENT_MODIFIED_BACKOFF: [Duration; 2] = [Duration::from_millis(40), Duration::from_millis(120)];

pub struct BridgeOptions {
    pub process: ProcessOptions,
    pub read: ReadFn,
    pub has: HasFn,
    /// Most documents kept open beyond the tracked set.
    pub max_open: Option<usize>,
}

/// `answer`'s reason it may be incomplete: the server's background work, when it came back empty.
fn inconclusive(empty: bool, busy: Option<String>) -> Option<String> {
    busy.filter(|_| empty)
}

/// One server: the process, its open documents and the path mapping are `LspProcess`, `Documents`
/// and `Locator`; this is where the requests and their result shapes live.
pub struct LspBridge {
    process: Arc<LspProcess>,
    documents: Documents,
    locator: Locator,
    root: PathBuf,
}

impl LspBridge {
    pub fn new(opts: BridgeOptions) -> Self {
        let root = opts.process.root.clone();
        let process = LspProcess::start(opts.process);
        let uri_root = root.clone();
        let uri = Arc::new(move |path: &str| file_uri(&uri_root, path));
        let documents = Documents::new(process.clone(), opts.read.clone(), uri, opts.max_open);
        let locator = Locator::new(root.clone(), opts.read, opts.has);
        Self { process, documents, locator, root }
    }

    /// The server process, for what goes to it beside the queries: diagnostics and tests.
    pub fn process(&self) -> &Arc<LspProcess> {
        &self.process
    }

    pub fn status(&self) -> LspProcessStatus {
        self.process.status()
    }

    pub fn entries(&self) -> Vec<LspLogEntry> {
        self.process.entries()
    }

    pub fn features(&self) -> Vec<LspFeature> {
        self.process.features()
    }

    pub async fn definition(&self, pos: &LspPosition) -> Result<LspLocationsResponse> {
        self.locations(LspFeature::Definition, "textDocument/definition", pos, json!({})).await
    }

    pub async fn type_definition(&self, pos: &LspPosition) -> Result<LspLocationsResponse> {
        self.locations(LspFeature::TypeDefinition, "textDocument/typeDefinition", pos, json!({})).await
    }

    pub async fn references(&self, pos: &LspPosition) -> Result<LspLocationsResponse> {
        let extra = json!({ "context": { "includeDeclaration": true } });
        self.locations(LspFeature::References, "textDocument/references", pos, extra).await
    }

    pub async fn hover(&self, pos: &LspPosition) -> Result<LspHoverResponse> {
        let params = self.at(pos, json!({}));
        let (result, busy) = self.query("textDocument/hover", params, Some(&pos.path), Some(LspFeature::Hover)).await?;
        let Some(md) = result.get("contents").and_then(hover_markdown) else {
            return Ok(LspHoverResponse { contents: None, range: None, inconclusive: inconclusive(true, busy) });
        };
        let contents = localize_file_links(&md, &self.locator.links(&md).await);
        let range = result.get("range").and_then(|r| serde_json::from_value::<Range>(r.clone()).ok()).map(|r| {
            let (line, col, end_line, end_col) = from_lsp(&r);
            LspHoverResponseRange { line, col, end_line, end_col }
        });
        Ok(LspHoverResponse { contents: Some(contents), range, inconclusive: None })
    }

    /// Where else the symbol at `pos` occurs in its file, via `textDocument/documentHighlight`, so
    /// scope and shadowing are the server's call. A server not offering it, or a position holding
    /// no symbol, yields none: the answer is advisory.
    pub async fn occurrences(&self, pos: &LspPosition) -> Result<LspOccurrencesResponse> {
        let params = self.at(pos, json!({}));
        let result = match self
            .query("textDocument/documentHighlight", params, Some(&pos.path), Some(LspFeature::DocumentHighlight))
            .await
        {
            Ok((result, _)) => result,
            Err(Error::LspUnsupported(_)) => Value::Null,
            Err(e) => return Err(e),
        };
        let occurrences = result
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|h| {
                let range: Range = serde_json::from_value(h.get("range")?.clone()).ok()?;
                let (line, col, end_line, end_col) = from_lsp(&range);
                let kind = match h.get("kind").and_then(Value::as_i64) {
                    Some(3) => LspOccurrenceKind::Write,
                    Some(2) => LspOccurrenceKind::Read,
                    _ => LspOccurrenceKind::Text,
                };
                Some(LspOccurrence {
                    line: NonZeroU64::new(line as u64)?,
                    col,
                    end_line: NonZeroU64::new(end_line as u64)?,
                    end_col,
                    kind,
                })
            })
            .collect();
        Ok(LspOccurrencesResponse { occurrences })
    }

    /// Keeps the diff's own files open in the server (see `Documents::track`). Never fails.
    pub async fn track(&self, paths: &[String]) {
        self.documents.track(paths).await;
    }

    pub async fn document_symbols(&self, path: &str) -> Result<LspSymbolsResponse> {
        let params = json!({ "textDocument": { "uri": file_uri(&self.root, path) } });
        let (result, busy) =
            self.query("textDocument/documentSymbol", params, Some(path), Some(LspFeature::DocumentSymbol)).await?;
        let symbols = if result.is_null() { Vec::new() } else { flatten_symbols(&result, path) };
        Ok(LspSymbolsResponse { inconclusive: inconclusive(symbols.is_empty(), busy), symbols })
    }

    /// Symbols the server knows for `query`, limited to paths the snapshot exposes, in the server's
    /// order: the pool ranks the union. Membership comes from `has`, never from reading the file: a
    /// per-keystroke search must not read every hit's text.
    pub async fn workspace_symbols(&self, query: &str) -> Result<LspSymbolsResponse> {
        let (result, busy) =
            self.query("workspace/symbol", json!({ "query": query }), None, Some(LspFeature::WorkspaceSymbol)).await?;
        let Some(list) = result.as_array() else {
            return Ok(LspSymbolsResponse { symbols: Vec::new(), inconclusive: inconclusive(true, busy) });
        };
        let mut paths = Vec::with_capacity(list.len());
        for s in list {
            let uri = s.pointer("/location/uri").and_then(Value::as_str);
            paths.push(match uri {
                Some(uri) => self.locator.path_of(uri).await,
                None => None,
            });
        }
        let inside = self.locator.membership(&paths).await;
        let mut seen = HashSet::new();
        let symbols: Vec<_> = list
            .iter()
            .zip(&paths)
            .filter_map(|(s, path)| {
                let path = path.as_ref().filter(|p| inside.get(*p).copied().unwrap_or(false))?;
                let symbol = symbol_information(s, path)?;
                // pyrefly reports one entry per import site; one per definition is enough here.
                seen.insert(format!("{path}:{}:{}:{}", symbol.line, symbol.col, symbol.name)).then_some(symbol)
            })
            .collect();
        Ok(LspSymbolsResponse { inconclusive: inconclusive(symbols.is_empty(), busy), symbols })
    }

    /// Reads a file outside the snapshot only if a result named it (see `Locator::read_external`).
    pub async fn read_external(&self, path: &str) -> Option<Vec<u8>> {
        self.locator.read_external(path).await
    }

    /// Replaces the server's settings (see `LspProcess::reconfigure`).
    pub fn reconfigure(&self, settings: SettingsFuture) {
        self.process.reconfigure(settings);
    }

    pub async fn close(&self) {
        self.process.close().await;
    }

    fn at(&self, pos: &LspPosition, extra: Value) -> Value {
        let mut params = json!({
            "textDocument": { "uri": file_uri(&self.root, &pos.path) },
            "position": to_lsp(pos.line.get() as i64, pos.col),
        });
        if let (Some(params), Some(extra)) = (params.as_object_mut(), extra.as_object()) {
            params.extend(extra.clone());
        }
        params
    }

    async fn locations(
        &self,
        feature: LspFeature,
        method: &str,
        pos: &LspPosition,
        extra: Value,
    ) -> Result<LspLocationsResponse> {
        let (result, busy) = self.query(method, self.at(pos, extra), Some(&pos.path), Some(feature)).await?;
        let text_of = |path: &str| self.documents.text_of(path);
        let locations = self.locator.locations(&normalize_locations(&result), &text_of).await;
        Ok(LspLocationsResponse { inconclusive: inconclusive(locations.is_empty(), busy), locations })
    }

    /// One request against a synced document, asked again while the server answers
    /// `ContentModified`: something moved the document under it, so it refuses to answer from text
    /// it no longer holds. Re-syncing and asking again is what an editor does; giving up reads as
    /// an outage. A feature the server never advertised is not asked for. The second value is why
    /// an empty result may be incomplete: background work the server reported.
    async fn query(
        &self,
        method: &str,
        params: Value,
        path: Option<&str>,
        feature: Option<LspFeature>,
    ) -> Result<(Value, Option<String>)> {
        for attempt in 0.. {
            if let Some(path) = path {
                self.documents.sync(path).await?;
            }
            let rpc = self.process.connection().await?;
            if let Some(feature) = feature.filter(|f| !self.process.supports(*f)) {
                return Err(Error::LspUnsupported(format!(
                    "{} offers no {}",
                    self.process.name(),
                    feature_label(feature)
                )));
            }
            let pending = self.process.busy();
            match rpc.request(method, params.clone(), None).await {
                Ok(result) => return Ok((result, self.process.busy().or(pending))),
                Err(RequestError::Rpc(e)) if e.code == CONTENT_MODIFIED => {
                    let Some(backoff) = CONTENT_MODIFIED_BACKOFF.get(attempt) else {
                        let what = path.unwrap_or("the repository");
                        let name = self.process.name();
                        return Err(Error::LspUnavailable(format!(
                            "{name} could not answer while {what} kept changing; try again"
                        )));
                    };
                    tokio::time::sleep(*backoff).await;
                }
                Err(RequestError::Closed(reason)) => return Err(Error::LspUnavailable(reason)),
                Err(e) => return Err(anyhow::anyhow!("{e}").into()),
            }
        }
        unreachable!("the loop returns")
    }
}

/// The document URI a server knows a snapshot path by.
pub fn file_uri(root: &std::path::Path, path: &str) -> String {
    url::Url::from_file_path(root.join(path))
        .map_or_else(|()| format!("file://{}/{path}", root.display()), |u| u.to_string())
}
