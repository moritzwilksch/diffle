//! One long-lived `git cat-file --batch` per repository.
use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as SyncMutex};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout};
use tokio::sync::{Mutex, oneshot};

use super::exec::{ExecOptions, command, exec_git, text};
use crate::error::GitError;

/// An idle batch is reaped after this long; the next request respawns one.
const IDLE: Duration = Duration::from_secs(2);

pub struct CatFileObject {
    pub kind: String,
    pub size: usize,
    /// The first `keep` bytes of the object.
    pub body: Vec<u8>,
}

type Answer = Result<Option<CatFileObject>, GitError>;

struct Pending {
    keep: usize,
    tx: oneshot::Sender<Answer>,
}

struct Live {
    stdin: ChildStdin,
    pending: Arc<SyncMutex<VecDeque<Pending>>>,
    id: usize,
}

/// Object names go in on stdin and come back in order on stdout, so a burst of reads (hydrating a
/// diff, sniffing every changed blob) costs one process instead of one each. Only the first
/// `keep` bytes of a body are retained. The child is reaped after `IDLE` without requests; if it
/// dies, every in-flight request fails and the next one starts over.
pub struct CatFileBatch {
    cwd: PathBuf,
    live: Arc<Mutex<Option<Live>>>,
    spawns: AtomicUsize,
}

impl CatFileBatch {
    pub fn new(cwd: PathBuf) -> Self {
        Self { cwd, live: Arc::new(Mutex::new(None)), spawns: AtomicUsize::new(0) }
    }

    pub fn spawns(&self) -> usize {
        self.spawns.load(Ordering::Relaxed)
    }

    /// The object any `cat-file` name (`sha`, `rev:path`) names, or none when git reports it
    /// missing or ambiguous. A name with a newline cannot ride the batch and gets a call of its own.
    pub async fn request(&self, name: &str, keep: usize) -> Answer {
        if name.contains('\n') {
            return self.single(name, keep).await;
        }
        let rx = {
            let mut live = self.live.lock().await;
            if live.is_none() {
                *live = Some(self.spawn()?);
            }
            let batch = live.as_mut().expect("spawned");
            let (tx, rx) = oneshot::channel();
            // Queued and written under one lock, so answers pair with requests in order.
            batch.pending.lock().unwrap().push_back(Pending { keep, tx });
            if let Err(e) = batch.stdin.write_all(format!("{name}\n").as_bytes()).await {
                let failed = batch.pending.lock().unwrap().pop_back();
                *live = None;
                drop(failed);
                return Err(GitError::refused(format!("git cat-file --batch failed: {e}"), &["cat-file", "--batch"]));
            }
            rx
        };
        rx.await.unwrap_or_else(|_| Err(GitError::refused("git cat-file --batch exited", &["cat-file", "--batch"])))
    }

    async fn single(&self, name: &str, keep: usize) -> Answer {
        let Ok(kind) = exec_git(&self.cwd, &["cat-file", "-t", name], ExecOptions::default()).await else {
            return Ok(None);
        };
        let kind = text(kind).trim().to_owned();
        let mut body = exec_git(&self.cwd, &["cat-file", &kind, name], ExecOptions::default()).await?;
        let size = body.len();
        body.truncate(keep);
        Ok(Some(CatFileObject { kind, size, body }))
    }

    fn spawn(&self) -> Result<Live, GitError> {
        let mut child = command(&self.cwd, &["cat-file", "--batch"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| GitError::refused(format!("git cat-file --batch failed: {e}"), &["cat-file", "--batch"]))?;
        let id = self.spawns.fetch_add(1, Ordering::Relaxed) + 1;
        let pending = Arc::new(SyncMutex::new(VecDeque::new()));
        let stdout = child.stdout.take().expect("piped stdout");
        let stdin = child.stdin.take().expect("piped stdin");
        let (live, queue) = (self.live.clone(), pending.clone());
        tokio::spawn(async move {
            let error = read_answers(stdout, &queue, &live, id).await;
            let mut slot = live.lock().await;
            if slot.as_ref().is_some_and(|l| l.id == id) {
                *slot = None;
            }
            drop(slot);
            for p in queue.lock().unwrap().drain(..) {
                let _ = p.tx.send(Err(error.clone()));
            }
            let _ = child.wait().await;
        });
        Ok(Live { stdin, pending, id })
    }
}

/// Answers per name: `<sha> <type> <size>\n<body>\n`, or `<name> missing\n` (also `ambiguous`).
/// Returns why the batch ended: its exit, a read error, or being reaped while idle.
async fn read_answers(
    stdout: ChildStdout,
    queue: &SyncMutex<VecDeque<Pending>>,
    live: &Mutex<Option<Live>>,
    id: usize,
) -> GitError {
    let exited =
        |why: String| GitError::refused(format!("git cat-file --batch exited: {why}"), &["cat-file", "--batch"]);
    let mut reader = BufReader::new(stdout);
    let mut header = Vec::new();
    loop {
        // A read the idle timeout cancelled keeps its partial bytes in `header`; the retry appends.
        let idle = queue.lock().unwrap().is_empty();
        let read = reader.read_until(b'\n', &mut header);
        let n = if idle {
            match tokio::time::timeout(IDLE, read).await {
                Ok(n) => n,
                Err(_) => {
                    // Reap only if still idle: requests queue under the same lock that holds `live`.
                    let mut slot = live.lock().await;
                    if queue.lock().unwrap().is_empty() && slot.as_ref().is_some_and(|l| l.id == id) {
                        *slot = None;
                        return exited("idle".into());
                    }
                    drop(slot);
                    continue;
                }
            }
        } else {
            read.await
        };
        let n = match n {
            Ok(n) => n,
            Err(e) => return exited(e.to_string()),
        };
        if n == 0 || header.last() != Some(&b'\n') {
            return exited("end of output".into());
        }
        let line = String::from_utf8_lossy(&header[..header.len() - 1]).into_owned();
        header.clear();
        let Some(req) = queue.lock().unwrap().pop_front() else {
            return exited("unexpected output".into());
        };
        let fields: Vec<&str> = line.split(' ').collect();
        // A miss echoes the request name, which may itself contain spaces (`HEAD:no such.txt missing`).
        let tail = fields.last().copied().unwrap_or_default();
        if tail == "missing" || tail == "ambiguous" || fields.len() < 3 {
            let _ = req.tx.send(Ok(None));
            continue;
        }
        let size: usize = fields[2].parse().unwrap_or(0);
        let kept = size.min(req.keep);
        let mut body = vec![0u8; kept];
        if let Err(e) = reader.read_exact(&mut body).await {
            return exited(e.to_string());
        }
        // The rest of the body and its trailing newline are read and dropped.
        let rest = (size - kept + 1) as u64;
        match tokio::io::copy(&mut (&mut reader).take(rest), &mut tokio::io::sink()).await {
            Ok(n) if n == rest => {}
            Ok(_) => return exited("truncated object".into()),
            Err(e) => return exited(e.to_string()),
        }
        let _ = req.tx.send(Ok(Some(CatFileObject { kind: fields[1].to_owned(), size, body })));
    }
}
