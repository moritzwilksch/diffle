//! A GitHub that answers GraphQL by query shape.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use diffle::error::GithubError;
use diffle::github::client::GithubClient;
use futures::future::BoxFuture;
use serde_json::{Value, json};

type Answer = BoxFuture<'static, Result<Value, GithubError>>;
type Handler = Arc<dyn Fn(String, Value) -> Answer + Send + Sync>;

/// One recorded GraphQL call.
#[derive(Clone, Debug)]
pub struct Call {
    pub query: String,
    pub variables: Value,
}

/// Answers each call through `handler`; records the calls it answered, not the ones it failed.
#[derive(Clone)]
pub struct FakeGithub {
    pub calls: Arc<Mutex<Vec<Call>>>,
    handler: Handler,
}

impl FakeGithub {
    pub fn new<F, Fut>(handler: F) -> Self
    where
        F: Fn(String, Value) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Value, GithubError>> + Send + 'static,
    {
        Self { calls: Arc::default(), handler: Arc::new(move |q, v| Box::pin(handler(q, v))) }
    }

    pub fn calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }

    pub fn clear(&self) {
        self.calls.lock().unwrap().clear();
    }

    /// Removes the last recorded call and answers its variables.
    pub fn pop(&self) -> Value {
        self.calls.lock().unwrap().pop().expect("a recorded call").variables
    }

    /// The variables of every recorded call.
    pub fn variables(&self) -> Vec<Value> {
        self.calls().into_iter().map(|c| c.variables).collect()
    }
}

impl GithubClient for FakeGithub {
    fn graphql(&self, query: &str, variables: Value, _: Option<Duration>) -> BoxFuture<'_, Result<Value, GithubError>> {
        let (calls, answer) = (self.calls.clone(), (self.handler)(query.to_owned(), variables.clone()));
        let query = query.to_owned();
        Box::pin(async move {
            let out = answer.await?;
            calls.lock().unwrap().push(Call { query, variables });
            Ok(out)
        })
    }
}

/// A GitHub that knows one pull request, answering lookups by number and by head branch alike.
pub fn knows(node: Option<Value>) -> FakeGithub {
    FakeGithub::new(move |query: String, _| {
        let node = node.clone();
        async move {
            if query.contains("pullRequests(") {
                let nodes: Vec<Value> = node.into_iter().collect();
                return Ok(json!({ "repository": { "pullRequests": { "nodes": nodes } } }));
            }
            Ok(json!({ "repository": { "pullRequest": node } }))
        }
    })
}
