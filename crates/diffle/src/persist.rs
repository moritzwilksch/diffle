//! Durable writes under `<git-dir>/diffle/`: atomic replacement and a cross-process lock; and where
//! diffle's per-user files live.
use std::fs::{File, OpenOptions, TryLockError};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{Context, bail};

/// `$XDG_CONFIG_HOME/diffle`, or `~/.config/diffle`: the same place on every platform, so a run
/// can be pointed at its own settings by the one variable.
pub fn user_config_dir() -> PathBuf {
    user_dir("XDG_CONFIG_HOME", ".config")
}

/// `$XDG_CACHE_HOME/diffle`, or `~/.cache/diffle`.
pub fn user_cache_dir() -> PathBuf {
    user_dir("XDG_CACHE_HOME", ".cache")
}

fn user_dir(var: &str, under_home: &str) -> PathBuf {
    let base = std::env::var_os(var)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::home_dir().map(|h| h.join(under_home)))
        .unwrap_or_else(std::env::temp_dir);
    base.join("diffle")
}

const LOCK_TIMEOUT: Duration = Duration::from_secs(10);
const LOCK_POLL: Duration = Duration::from_millis(15);

/// Writes `text` to `file` atomically: a unique temp file in the same directory, then rename. The
/// directory is created owner-only and the file is owner-readable only. A failed write leaves no
/// temp file behind.
pub async fn write_file_atomic(file: &Path, text: &str) -> anyhow::Result<()> {
    let dir = file.parent().context("file has no directory")?;
    create_private_dir(dir).await?;
    let name = file.file_name().context("file has no name")?.to_string_lossy();
    let tmp = dir.join(format!("{name}.{}.{}.tmp", std::process::id(), uuid::Uuid::new_v4().simple()));
    let written = async {
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut out = options.open(&tmp).await?;
        tokio::io::AsyncWriteExt::write_all(&mut out, text.as_bytes()).await?;
        out.sync_all().await?;
        drop(out);
        tokio::fs::rename(&tmp, file).await
    };
    if let Err(e) = written.await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e).with_context(|| format!("writing {}", file.display()));
    }
    Ok(())
}

async fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    let mut builder = tokio::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    builder.mode(0o700);
    builder.create(dir).await
}

/// Runs `f` while holding an exclusive OS lock on `<file>.lock`, across processes and within this
/// one (each acquisition opens its own handle). The OS drops the lock with its holder, so a
/// crashed server never strands it; waiting longer than ten seconds fails.
pub async fn with_file_lock<R, Fut>(file: &Path, f: impl FnOnce() -> Fut) -> anyhow::Result<R>
where
    Fut: Future<Output = anyhow::Result<R>>,
{
    let lock = lock_path(file);
    create_private_dir(lock.parent().context("lock has no directory")?).await?;
    let held = acquire(&lock).await?;
    let result = f().await;
    drop(held);
    result
}

fn lock_path(file: &Path) -> PathBuf {
    let mut name = file.as_os_str().to_owned();
    name.push(".lock");
    PathBuf::from(name)
}

async fn acquire(lock: &Path) -> anyhow::Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).write(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let handle = options.open(lock)?;
    let deadline = Instant::now() + LOCK_TIMEOUT;
    loop {
        match handle.try_lock() {
            Ok(()) => return Ok(handle),
            Err(TryLockError::WouldBlock) => {}
            Err(TryLockError::Error(e)) => return Err(e.into()),
        }
        if Instant::now() > deadline {
            bail!("timed out waiting for {}", lock.display());
        }
        tokio::time::sleep(LOCK_POLL).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn serializes_holders_and_writes_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let file = Arc::new(dir.path().join("state").join("data.json"));
        let inside = Arc::new(AtomicUsize::new(0));
        let tasks = (0..8).map(|i| {
            let (file, inside) = (file.clone(), inside.clone());
            tokio::spawn(async move {
                with_file_lock(&file, || async {
                    assert_eq!(inside.fetch_add(1, Ordering::SeqCst), 0, "two holders at once");
                    write_file_atomic(&file, &format!("{i}\n")).await?;
                    tokio::time::sleep(Duration::from_millis(5)).await;
                    inside.fetch_sub(1, Ordering::SeqCst);
                    Ok(())
                })
                .await
                .unwrap();
            })
        });
        futures::future::join_all(tasks).await;
        let left: Vec<_> = std::fs::read_dir(file.parent().unwrap()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(left.len(), 2, "only the file and its lock remain: {left:?}");
    }
}
