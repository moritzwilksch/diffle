//! The diffle running for the agent's repository, as its announcement names and its server confirms.
use std::path::Path;

use anyhow::{Context, bail};
use serde::de::DeserializeOwned;

use crate::error::{Error, Result};
use crate::protocol::ApiError;
use crate::server::announce::{self, Lookup};

/// A running diffle that confirmed it serves the repository.
pub struct Diffle {
    http: reqwest::Client,
    base: url::Url,
}

/// The diffle serving `git_dir`.
pub async fn reach(git_dir: &Path) -> Result<Diffle> {
    match announce::lookup(git_dir).await {
        Lookup::Live { url, .. } => {
            let (http, base) = announce::client(&url).context("a confirmed run's url")?;
            Ok(Diffle { http, base })
        }
        Lookup::Silent { url } => Err(Error::NotAnswering(url)),
        Lookup::Absent => Err(Error::NotRunning),
    }
}

impl Diffle {
    /// `GET path`, relative to the server root and with its query, parsed from JSON.
    pub async fn get<T: DeserializeOwned>(&self, path: &str) -> anyhow::Result<T> {
        let response = self.http.get(self.base.join(path)?).send().await.with_context(|| format!("GET {path}"))?;
        let status = response.status();
        if !status.is_success() {
            let error = response.json::<ApiError>().await.map_or_else(|e| e.to_string(), |e| e.error);
            bail!("GET {path} answered {status}: {error}");
        }
        Ok(response.json().await?)
    }
}
