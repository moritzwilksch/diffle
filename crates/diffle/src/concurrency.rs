use std::future::Future;

use futures::{StreamExt, stream};

/// Runs `f` over `items` with at most `limit` in flight; results keep input order.
pub async fn map_limit<T, R, F, Fut>(items: impl IntoIterator<Item = T>, limit: usize, f: F) -> Vec<R>
where
    F: FnMut(T) -> Fut,
    Fut: Future<Output = R>,
{
    stream::iter(items).map(f).buffered(limit).collect().await
}
