//! The connected-clusters graph of the current snapshot.
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::get;
use futures::FutureExt;

use super::{ApiDeps, ApiResult};
use crate::graph::collect::build;
use crate::graph::limits::Limits;
use crate::graph::source::PoolSource;

pub fn routes() -> Router<Arc<ApiDeps>> {
    Router::new().route("/api/graph", get(graph))
}

/// Never refuses for want of a language server: the answer then lists every changed file under
/// `other` with a `note`. Concurrent requests for one snapshot share one build.
async fn graph(State(d): State<Arc<ApiDeps>>) -> ApiResult {
    let snapshotter = d.session.snapshotter()?;
    let snap = snapshotter.current().await?;
    let source = PoolSource::new(d.lsp.clone(), snapshotter, snap.clone());
    let started = snap.clone();
    let graph =
        d.graph.get(&snap, move || async move { build(&source, &started, &Limits::DEFAULT).await }.boxed()).await?;
    Ok(Json(&*graph).into_response())
}
