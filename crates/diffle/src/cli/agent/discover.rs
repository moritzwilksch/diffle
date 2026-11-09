//! Finds the diffle serving a repository through its announcements under `<git-dir>/diffle/servers/`.
//! An entry counts only once the server it names confirms it; the first client to find an entry
//! dead deletes it, so no client ever acts on a crashed run's file or a reused port.
use std::path::Path;
use std::time::Duration;

use anyhow::{Context, bail};
use serde::de::DeserializeOwned;

use crate::error::{Error, Result};
use crate::protocol::{ApiError, ServerInfo};
use crate::server::announce::Announcement;

/// How long a server may take to accept a connection, and to confirm its announcement.
const CONFIRM_TIMEOUT: Duration = Duration::from_secs(2);

/// A running diffle that confirmed it serves the repository.
pub struct Diffle {
    pub info: ServerInfo,
    /// As announced: `http://host:port/`, or `unix:<path>`.
    pub url: String,
    http: reqwest::Client,
    base: url::Url,
}

/// The one diffle serving `git_dir`, or the run named `instance`. Deletes every announcement whose
/// server does not confirm it.
pub async fn discover(git_dir: &Path, instance: Option<&str>) -> Result<Diffle> {
    let checks = announcements(git_dir).await?.into_iter().map(|file| async move {
        let confirmed = confirm(&file, git_dir).await;
        if confirmed.is_none() {
            // Another client may have deleted it first.
            let _ = tokio::fs::remove_file(&file).await;
        }
        confirmed
    });
    let live = futures::future::join_all(checks).await.into_iter().flatten().collect();
    pick(live, instance)
}

/// The announcement files under `git_dir`, without `write_file_atomic`'s staging files.
async fn announcements(git_dir: &Path) -> Result<Vec<std::path::PathBuf>> {
    let mut entries = match tokio::fs::read_dir(git_dir.join("diffle").join("servers")).await {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut files = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "json") {
            files.push(path);
        }
    }
    Ok(files)
}

/// The server `file` announces, if it answers as that run for `git_dir`.
async fn confirm(file: &Path, git_dir: &Path) -> Option<Diffle> {
    let announcement: Announcement = serde_json::from_str(&tokio::fs::read_to_string(file).await.ok()?).ok()?;
    let (http, base) = connect(&announcement.url)?;
    let response = http.get(base.join("api/server").ok()?).timeout(CONFIRM_TIMEOUT).send().await.ok()?;
    let info: ServerInfo = response.error_for_status().ok()?.json().await.ok()?;
    let confirmed = info.instance == announcement.instance && Path::new(&info.git_dir) == git_dir;
    confirmed.then_some(Diffle { info, url: announcement.url, http, base })
}

/// A client for `url` and the base its requests resolve against; a socket's requests name `localhost`.
fn connect(url: &str) -> Option<(reqwest::Client, url::Url)> {
    // A proxy from the environment must not stand between the CLI and a local server.
    let builder = reqwest::Client::builder().no_proxy().connect_timeout(CONFIRM_TIMEOUT);
    let Some(socket) = url.strip_prefix("unix:") else {
        return Some((builder.build().ok()?, url::Url::parse(url).ok()?));
    };
    #[cfg(unix)]
    return Some((builder.unix_socket(socket).build().ok()?, url::Url::parse("http://localhost/").ok()?));
    // Only a Unix system listens on a socket.
    #[cfg(not(unix))]
    {
        let _ = (builder, socket);
        None
    }
}

/// The run among `live` that a call reaches: the one named `instance`, else the only one.
fn pick(mut live: Vec<Diffle>, instance: Option<&str>) -> Result<Diffle> {
    if let Some(instance) = instance {
        let Some(at) = live.iter().position(|d| d.info.instance == instance) else {
            return Err(Error::Discovery(format!("no diffle {instance} is running for this repository")));
        };
        return Ok(live.swap_remove(at));
    }
    match live.len() {
        0 => Err(Error::Discovery("no diffle is running for this repository".into())),
        1 => Ok(live.swap_remove(0)),
        _ => {
            live.sort_by(|a, b| a.info.instance.cmp(&b.info.instance));
            let runs: Vec<String> =
                live.iter().map(|d| format!("  {}  {}  {}", d.info.instance, d.url, d.info.label)).collect();
            Err(Error::Discovery(format!(
                "several diffle runs serve this repository; name one with --server <instance>:\n{}",
                runs.join("\n")
            )))
        }
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
