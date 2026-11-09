//! A run's announcement under `<git-dir>/diffle/servers/`, so a client on the same repository can
//! find it. A reader trusts an entry only once `GET /api/server` confirms its instance and git dir.
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::persist::write_file_atomic;

/// The content of `servers/<instance>.json`: a local file, not wire.
#[derive(Serialize, Deserialize)]
pub struct Announcement {
    /// Minted once per run; also the file's name.
    pub instance: String,
    pub pid: u32,
    /// `http://host:port/`, or `unix:<path>` for a socket.
    pub url: String,
    pub version: String,
}

/// A published announcement, until the run withdraws it.
pub struct Announced {
    file: PathBuf,
}

/// Writes this process's announcement for `instance`, listening at `url`, atomically.
pub async fn announce(git_dir: &Path, instance: &str, url: &str) -> anyhow::Result<Announced> {
    let announcement = Announcement {
        instance: instance.to_owned(),
        pid: std::process::id(),
        url: url.to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
    };
    let file = git_dir.join("diffle").join("servers").join(format!("{instance}.json"));
    write_file_atomic(&file, &(serde_json::to_string_pretty(&announcement)? + "\n")).await?;
    Ok(Announced { file })
}

impl Announced {
    /// Removes the file; a file already gone is withdrawn all the same.
    pub async fn withdraw(self) {
        let _ = tokio::fs::remove_file(&self.file).await;
    }
}
