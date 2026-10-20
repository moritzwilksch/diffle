//! One answer from several servers: what all of them said, owner first.
use std::collections::HashSet;

use futures::future::{BoxFuture, join_all};

use crate::error::Result;
use crate::protocol::{LspHoverResponse, LspLocationsResponse};

/// The union of what several servers answered. A server that fails drops its share; every one
/// failing is the first failure. When the union is `empty`, the first reason it may be incomplete
/// stands: a server's own, else a failed server's message, so an owner still starting reads as
/// such rather than as silence.
pub async fn union<T>(
    asked: Vec<BoxFuture<'_, Result<T>>>,
    merge: impl FnOnce(Vec<T>) -> T,
    empty: impl Fn(&T) -> bool,
    inconclusive: impl Fn(&mut T) -> &mut Option<String>,
) -> Result<T> {
    let results = join_all(asked).await;
    let mut answers = Vec::new();
    let mut failed = None;
    for result in results {
        match result {
            Ok(answer) => answers.push(answer),
            Err(e) => {
                failed.get_or_insert(e);
            }
        }
    }
    if answers.is_empty()
        && let Some(e) = failed
    {
        return Err(e);
    }
    let reason = answers.iter_mut().find_map(|a| inconclusive(a).clone()).or_else(|| failed.map(|e| e.to_string()));
    let mut merged = merge(answers);
    if empty(&merged)
        && let Some(reason) = reason
    {
        *inconclusive(&mut merged) = Some(reason);
    }
    Ok(merged)
}

/// Every server's hover, owner first, as one tooltip; the span is the first one offered.
pub fn merge_hovers(answers: Vec<LspHoverResponse>) -> LspHoverResponse {
    let said: Vec<LspHoverResponse> = answers.into_iter().filter(|a| a.contents.is_some()).collect();
    if said.is_empty() {
        return LspHoverResponse { contents: None, range: None, inconclusive: None };
    }
    let range = said.iter().find_map(|a| a.range.clone());
    let contents: Vec<String> = said.into_iter().filter_map(|a| a.contents).collect();
    LspHoverResponse { contents: Some(contents.join("\n\n---\n\n")), range, inconclusive: None }
}

/// The union of every server's locations, owner first, each place once.
pub fn merge_locations(answers: Vec<LspLocationsResponse>) -> LspLocationsResponse {
    let mut seen = HashSet::new();
    let locations = answers
        .into_iter()
        .flat_map(|a| a.locations)
        .filter(|l| seen.insert((l.path.to_string(), l.line, l.col)))
        .collect();
    LspLocationsResponse { locations, inconclusive: None }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Error;
    use futures::FutureExt;

    fn hover(contents: Option<&str>, inconclusive: Option<&str>) -> LspHoverResponse {
        LspHoverResponse {
            contents: contents.map(str::to_owned),
            range: None,
            inconclusive: inconclusive.map(str::to_owned),
        }
    }

    async fn merged(asked: Vec<Result<LspHoverResponse>>) -> Result<LspHoverResponse> {
        let asked = asked.into_iter().map(|r| async move { r }.boxed()).collect();
        union(asked, merge_hovers, |h| h.contents.is_none(), |h| &mut h.inconclusive).await
    }

    #[tokio::test]
    async fn joins_what_servers_said_and_explains_an_empty_union() {
        let both = merged(vec![Ok(hover(Some("a"), None)), Ok(hover(Some("b"), None))]).await.unwrap();
        assert_eq!(both.contents.as_deref(), Some("a\n\n---\n\nb"));
        let starting = Err(Error::LspUnavailable("pyrefly is starting".into()));
        let explained = merged(vec![Ok(hover(None, None)), starting]).await.unwrap();
        assert_eq!(explained.inconclusive.as_deref(), Some("pyrefly is starting"));
        let busy = merged(vec![Ok(hover(None, Some("busy"))), Ok(hover(Some("x"), None))]).await.unwrap();
        assert_eq!((busy.contents.as_deref(), busy.inconclusive), (Some("x"), None));
        let all = merged(vec![Err(Error::LspUnavailable("first".into())), Err(Error::LspUnavailable("second".into()))]);
        assert_eq!(all.await.unwrap_err().to_string(), "first");
    }
}
