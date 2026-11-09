//! The run's announcement, `<git-dir>/diffle/server.json`: one diffle per git dir. A reader trusts
//! the entry only once the server it names confirms it through `GET /api/server`; the first reader
//! to find it dead deletes it, so nothing acts on a crashed run's file or a reused port.
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::persist::write_file_atomic;
use crate::protocol::ServerInfo;

/// How long a connection may take: a local one completes at once, even to a busy server.
const TIMEOUT_CONNECT: Duration = Duration::from_secs(1);
/// How long a connected server may take to confirm its announcement.
const TIMEOUT_CONFIRM: Duration = Duration::from_secs(2);

/// The content of `server.json`: a local file, not wire.
#[derive(Serialize, Deserialize)]
pub struct Announcement {
    /// Minted once per run.
    pub instance: String,
    pub pid: u32,
    /// `http://host:port/`, or `unix:<path>` for a socket.
    pub url: String,
    pub version: String,
}

/// This run's published announcement, until it withdraws it.
pub struct Announced {
    file: PathBuf,
    instance: String,
}

/// What reading the announcement under a git dir found.
pub enum Lookup {
    /// A run that confirmed it serves the repository.
    Live { info: ServerInfo, url: String },
    /// A run that accepted the connection but did not answer in time: maybe busy, so its entry stays.
    Silent { url: String },
    /// No entry, or a dead one, now deleted.
    Absent,
}

/// Writes this process's announcement for `instance`, listening at `url`, atomically. It replaces
/// whatever entry was there.
pub async fn announce(git_dir: &Path, instance: &str, url: &str) -> anyhow::Result<Announced> {
    let announcement = Announcement {
        instance: instance.to_owned(),
        pid: std::process::id(),
        url: url.to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
    };
    let file = announcement_file(git_dir);
    write_file_atomic(&file, &(serde_json::to_string_pretty(&announcement)? + "\n")).await?;
    Ok(Announced { file, instance: instance.to_owned() })
}

impl Announced {
    /// Removes the file while it still names this run; a later run's entry stays.
    pub async fn withdraw(self) {
        if read(&self.file).await.is_some_and(|a| a.instance == self.instance) {
            let _ = tokio::fs::remove_file(&self.file).await;
        }
    }
}

/// The run serving `git_dir`, as its announcement names and its server confirms. Deletes a dead entry.
pub async fn lookup(git_dir: &Path) -> Lookup {
    let file = announcement_file(git_dir);
    let Ok(text) = tokio::fs::read_to_string(&file).await else { return Lookup::Absent };
    let lookup = match serde_json::from_str::<Announcement>(&text) {
        Ok(announcement) => confirm(announcement, git_dir).await,
        Err(_) => Lookup::Absent,
    };
    if matches!(lookup, Lookup::Absent) {
        // Another reader may have deleted it first.
        let _ = tokio::fs::remove_file(&file).await;
    }
    lookup
}

fn announcement_file(git_dir: &Path) -> PathBuf {
    git_dir.join("diffle").join("server.json")
}

async fn read(file: &Path) -> Option<Announcement> {
    serde_json::from_str(&tokio::fs::read_to_string(file).await.ok()?).ok()
}

/// Whether `announcement` names a server that answers as that run for `git_dir`.
async fn confirm(announcement: Announcement, git_dir: &Path) -> Lookup {
    let Some((http, base)) = client(&announcement.url) else { return Lookup::Absent };
    let url = base.join("api/server").expect("a relative path joins any base");
    let answer = async { http.get(url).send().await?.error_for_status()?.json::<ServerInfo>().await };
    let info = match answer.await {
        Ok(info) => info,
        // A busy server still accepts the connection (the kernel's backlog does), so only a timeout
        // after connecting means busy; a connect timeout is how Windows reports a closed loopback port.
        Err(e) if e.is_timeout() && !e.is_connect() => return Lookup::Silent { url: announcement.url },
        Err(_) => return Lookup::Absent,
    };
    if info.instance != announcement.instance || Path::new(&info.git_dir) != git_dir {
        return Lookup::Absent;
    }
    Lookup::Live { info, url: announcement.url }
}

/// A client for `url` and the base its requests resolve against; a socket's requests name `localhost`.
fn client(url: &str) -> Option<(reqwest::Client, url::Url)> {
    // A proxy from the environment must not stand between a client and a local server.
    let builder = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(TIMEOUT_CONNECT)
        .timeout(TIMEOUT_CONNECT + TIMEOUT_CONFIRM);
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
