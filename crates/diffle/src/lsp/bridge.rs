//! One language server as diffle asks it: requests against synced documents, answers in snapshot paths.
use std::collections::HashSet;
use std::num::NonZeroU64;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_lsp::lsp_types::{
    DocumentHighlightKind, DocumentHighlightParams, DocumentSymbolParams, GotoDefinitionParams, GotoDefinitionResponse,
    HoverParams, ReferenceContext, ReferenceParams, TextDocumentIdentifier, TextDocumentPositionParams, Url,
    WorkspaceSymbolParams,
};
use async_lsp::{ErrorCode, LanguageServer, ServerSocket};
use futures::FutureExt;
use futures::future::BoxFuture;

use super::documents::{Documents, ReadFn};
use super::hover::{hover_markdown, localize_file_links};
use super::locator::{HasFn, Locator};
use super::process::{LspProcess, ProcessOptions, SettingsFuture};
use super::rpc::RequestError;
use super::shapes::{flatten_symbols, from_lsp, locations, to_lsp, workspace_symbols};
use crate::error::{Error, Result};
use crate::protocol::{
    LspFeature, LspHoverResponse, LspHoverResponseRange, LspLocationsResponse, LspLogEntry, LspOccurrence,
    LspOccurrenceKind, LspOccurrencesResponse, LspPosition, LspProcessStatus, LspSymbolsResponse, feature_label,
};

/// Waits before re-asking a request the server refused as stale, one per attempt.
const CONTENT_MODIFIED_BACKOFF: [Duration; 2] = [Duration::from_millis(40), Duration::from_millis(120)];

/// A request through the `LanguageServer` calls, asked again as `query` needs.
type Ask<T> = Box<dyn Fn(&mut ServerSocket) -> BoxFuture<'static, async_lsp::Result<T>> + Send + Sync>;

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
/// and `Locator`; this is where the requests and their answers live.
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
        let params = self.goto(pos);
        self.locations(pos, LspFeature::Definition, Box::new(move |s| s.definition(params.clone()))).await
    }

    pub async fn type_definition(&self, pos: &LspPosition) -> Result<LspLocationsResponse> {
        let params = self.goto(pos);
        self.locations(pos, LspFeature::TypeDefinition, Box::new(move |s| s.type_definition(params.clone()))).await
    }

    pub async fn references(&self, pos: &LspPosition) -> Result<LspLocationsResponse> {
        let params = ReferenceParams {
            text_document_position: self.at(pos),
            context: ReferenceContext { include_declaration: true },
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
        };
        let ask = move |s: &mut ServerSocket| {
            s.references(params.clone()).map(|a| a.map(|list| list.map(GotoDefinitionResponse::Array))).boxed()
        };
        self.locations(pos, LspFeature::References, Box::new(ask)).await
    }

    pub async fn hover(&self, pos: &LspPosition) -> Result<LspHoverResponse> {
        let params =
            HoverParams { text_document_position_params: self.at(pos), work_done_progress_params: Default::default() };
        let ask = Box::new(move |s: &mut ServerSocket| s.hover(params.clone()));
        let (answer, busy) = self.query(Some(&pos.path), LspFeature::Hover, ask).await?;
        let Some((md, range)) = answer.and_then(|h| Some((hover_markdown(&h.contents)?, h.range))) else {
            return Ok(LspHoverResponse { contents: None, range: None, inconclusive: inconclusive(true, busy) });
        };
        let contents = localize_file_links(&md, &self.locator.links(&md).await);
        let range = range.map(|r| {
            let (line, col, end_line, end_col) = from_lsp(&r);
            LspHoverResponseRange { line, col, end_line, end_col }
        });
        Ok(LspHoverResponse { contents: Some(contents), range, inconclusive: None })
    }

    /// Where else the symbol at `pos` occurs in its file, via `textDocument/documentHighlight`, so
    /// scope and shadowing are the server's call. A server not offering it, or a position holding
    /// no symbol, yields none: the answer is advisory.
    pub async fn occurrences(&self, pos: &LspPosition) -> Result<LspOccurrencesResponse> {
        let params = DocumentHighlightParams {
            text_document_position_params: self.at(pos),
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
        };
        let ask = Box::new(move |s: &mut ServerSocket| s.document_highlight(params.clone()));
        let highlights = match self.query(Some(&pos.path), LspFeature::DocumentHighlight, ask).await {
            Ok((answer, _)) => answer.unwrap_or_default(),
            Err(Error::LspUnsupported(_)) => Vec::new(),
            Err(e) => return Err(e),
        };
        let occurrences = highlights
            .into_iter()
            .filter_map(|h| {
                let (line, col, end_line, end_col) = from_lsp(&h.range);
                let kind = match h.kind {
                    Some(DocumentHighlightKind::WRITE) => LspOccurrenceKind::Write,
                    Some(DocumentHighlightKind::READ) => LspOccurrenceKind::Read,
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
        let params = DocumentSymbolParams {
            text_document: TextDocumentIdentifier { uri: file_uri(&self.root, path) },
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
        };
        let ask = Box::new(move |s: &mut ServerSocket| s.document_symbol(params.clone()));
        let (answer, busy) = self.query(Some(path), LspFeature::DocumentSymbol, ask).await?;
        let symbols = answer.map_or_else(Vec::new, |a| flatten_symbols(a, path));
        Ok(LspSymbolsResponse { inconclusive: inconclusive(symbols.is_empty(), busy), symbols })
    }

    /// Symbols the server knows for `query`, limited to paths the snapshot exposes, in the server's
    /// order: the pool ranks the union. Membership comes from `has`, never from reading the file: a
    /// per-keystroke search must not read every hit's text.
    pub async fn workspace_symbols(&self, query: &str) -> Result<LspSymbolsResponse> {
        let params = WorkspaceSymbolParams { query: query.to_owned(), ..Default::default() };
        let ask = Box::new(move |s: &mut ServerSocket| s.symbol(params.clone()));
        let (answer, busy) = self.query(None, LspFeature::WorkspaceSymbol, ask).await?;
        let found = workspace_symbols(answer);
        let mut paths = Vec::with_capacity(found.len());
        for (uri, _) in &found {
            paths.push(self.locator.path_of(uri).await);
        }
        let inside = self.locator.membership(&paths).await;
        let mut seen = HashSet::new();
        let symbols: Vec<_> = found
            .iter()
            .zip(&paths)
            .filter_map(|((_, symbol), path)| {
                let path = path.as_ref().filter(|p| inside.get(*p).copied().unwrap_or(false))?;
                let symbol = symbol(path);
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

    fn at(&self, pos: &LspPosition) -> TextDocumentPositionParams {
        TextDocumentPositionParams {
            text_document: TextDocumentIdentifier { uri: file_uri(&self.root, &pos.path) },
            position: to_lsp(pos.line.get() as i64, pos.col),
        }
    }

    fn goto(&self, pos: &LspPosition) -> GotoDefinitionParams {
        GotoDefinitionParams {
            text_document_position_params: self.at(pos),
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
        }
    }

    async fn locations(
        &self,
        pos: &LspPosition,
        feature: LspFeature,
        ask: Ask<Option<GotoDefinitionResponse>>,
    ) -> Result<LspLocationsResponse> {
        let (answer, busy) = self.query(Some(&pos.path), feature, ask).await?;
        let text_of = |path: &str| self.documents.text_of(path);
        let locations = self.locator.locations(&locations(answer), &text_of).await;
        Ok(LspLocationsResponse { inconclusive: inconclusive(locations.is_empty(), busy), locations })
    }

    /// One request against a synced document, asked again while the server answers
    /// `ContentModified`: something moved the document under it, so it refuses to answer from text
    /// it no longer holds. Re-syncing and asking again is what an editor does; giving up reads as
    /// an outage. A feature the server never advertised is not asked for. The second value is why
    /// an empty answer may be incomplete: background work the server reported.
    async fn query<T>(&self, path: Option<&str>, feature: LspFeature, ask: Ask<T>) -> Result<(T, Option<String>)> {
        for attempt in 0.. {
            if let Some(path) = path {
                self.documents.sync(path).await?;
            }
            let rpc = self.process.connection().await?;
            if !self.process.supports(feature) {
                let name = self.process.name();
                return Err(Error::LspUnsupported(format!("{name} offers no {}", feature_label(feature))));
            }
            let pending = self.process.busy();
            match rpc.ask(&ask, None).await {
                Ok(answer) => return Ok((answer, self.process.busy().or(pending))),
                Err(RequestError::Rpc(e)) if e.code == ErrorCode::CONTENT_MODIFIED => {
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
pub fn file_uri(root: &std::path::Path, path: &str) -> Url {
    Url::from_file_path(root.join(path)).expect("the repository root is absolute")
}
