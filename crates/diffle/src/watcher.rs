//! Turns filesystem changes into one debounced `dirty` signal for the session.
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use notify::event::{AccessKind, AccessMode, MetadataKind, ModifyKind};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher as _};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

/// How often git metadata is polled.
const META_POLL: Duration = Duration::from_millis(100);

pub type IgnoredFn = Arc<dyn Fn() -> Arc<HashSet<String>> + Send + Sync>;

pub enum WatchTarget {
    /// The worktree and its git metadata. `ignored` lists repo-relative paths git ignores,
    /// directories with a trailing slash; the owner refreshes it.
    Worktree { root: PathBuf, git_dir: PathBuf, common_dir: PathBuf, ignored: IgnoredFn },
    /// Only the refs and HEAD: a comparison between commits.
    Refs { git_dir: PathBuf, common_dir: PathBuf },
}

impl WatchTarget {
    fn dirs(&self) -> (&Path, &Path) {
        match self {
            Self::Worktree { git_dir, common_dir, .. } | Self::Refs { git_dir, common_dir } => (git_dir, common_dir),
        }
    }
}

/// Git metadata the snapshot depends on, polled rather than watched: git replaces these files
/// atomically, which native watches can lose. HEAD and refs move the old side in every live mode;
/// in worktree mode the index also decides the tree and the changed set.
pub fn meta_paths(target: &WatchTarget) -> Vec<PathBuf> {
    let (git_dir, common_dir) = target.dirs();
    let mut paths = Vec::new();
    for path in [git_dir.join("HEAD"), common_dir.join("HEAD"), common_dir.join("refs"), common_dir.join("packed-refs")]
    {
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    if matches!(target, WatchTarget::Worktree { .. }) {
        paths.push(git_dir.join("index"));
    }
    paths
}

/// A running watch. Dropping it stops it too; `close` also cancels a pending signal.
pub struct Watcher {
    _native: Option<Arc<Mutex<RecommendedWatcher>>>,
    tasks: Vec<JoinHandle<()>>,
}

enum Signal {
    Changed,
    /// A directory appeared that a per-directory backend must start watching.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    NewDir(PathBuf),
}

impl Watcher {
    /// Starts observing; `on_dirty` runs once changes have been quiet for `debounce`. Returns once observing.
    pub async fn start(
        target: WatchTarget,
        debounce: Duration,
        on_dirty: impl Fn() + Send + Sync + 'static,
    ) -> anyhow::Result<Self> {
        let (tx, mut rx) = mpsc::unbounded_channel::<Signal>();
        let target = Arc::new(target);
        let native = match &*target {
            WatchTarget::Worktree { root, .. } => {
                // Registering the watches walks the worktree on Linux: off the runtime, so the
                // session's queue keeps serving while a large checkout is scanned.
                let (target, root, tx) = (target.clone(), root.clone(), tx.clone());
                let watcher = tokio::task::spawn_blocking(move || watch_worktree(&target, &root, tx)).await??;
                Some(Arc::new(Mutex::new(watcher)))
            }
            WatchTarget::Refs { .. } => None,
        };
        let meta = poll_meta(meta_paths(&target), tx).await;
        let (native_for_dirs, target_for_dirs) = (native.clone(), target.clone());
        let debounced = tokio::spawn(async move {
            while let Some(signal) = rx.recv().await {
                handle(signal, &native_for_dirs, &target_for_dirs);
                // Each further signal restarts the quiet period.
                loop {
                    match tokio::time::timeout(debounce, rx.recv()).await {
                        Ok(Some(signal)) => handle(signal, &native_for_dirs, &target_for_dirs),
                        Ok(None) => return,
                        Err(_) => break,
                    }
                }
                on_dirty();
            }
        });
        Ok(Self { _native: native, tasks: vec![meta, debounced] })
    }

    pub async fn close(self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

/// A new directory's subtree gets its watches off the runtime, like the initial walk: a checkout
/// can create thousands at once.
fn handle(signal: Signal, native: &Option<Arc<Mutex<RecommendedWatcher>>>, target: &Arc<WatchTarget>) {
    let Signal::NewDir(dir) = signal else { return };
    if let (Some(native), WatchTarget::Worktree { root, .. }) = (native, &**target) {
        let (native, target, root) = (native.clone(), target.clone(), root.clone());
        tokio::task::spawn_blocking(move || watch_dirs(&mut native.lock().unwrap(), &target, &root, &dir));
    }
}

fn watch_worktree(
    target: &Arc<WatchTarget>,
    root: &Path,
    tx: mpsc::UnboundedSender<Signal>,
) -> anyhow::Result<RecommendedWatcher> {
    let filter = target.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
        let Ok(event) = event else { return };
        if !counts(&event.kind) {
            return;
        }
        for path in &event.paths {
            if is_ignored(&filter, path) || is_git_lock(&filter, path) {
                continue;
            }
            if cfg!(target_os = "linux") && matches!(event.kind, EventKind::Create(_)) && path.is_dir() {
                let _ = tx.send(Signal::NewDir(path.clone()));
            }
            let _ = tx.send(Signal::Changed);
        }
    })?;
    if cfg!(target_os = "linux") {
        watch_dirs(&mut watcher, target, root, root);
    } else {
        watcher.watch(root, RecursiveMode::Recursive)?;
    }
    Ok(watcher)
}

/// inotify watches one directory at a time, and a recursive watch would also cover ignored trees
/// like `node_modules`: every directory under `dir` that git does not ignore gets its own watch.
fn watch_dirs(watcher: &mut RecommendedWatcher, target: &WatchTarget, root: &Path, dir: &Path) {
    let mut stack = vec![dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if (dir != root && is_ignored(target, &dir)) || watcher.watch(&dir, RecursiveMode::NonRecursive).is_err() {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                stack.push(entry.path());
            }
        }
    }
}

/// Changes to content or names; reads (inotify reports opens) and access-time updates are not changes.
fn counts(kind: &EventKind) -> bool {
    match kind {
        EventKind::Access(AccessKind::Close(AccessMode::Write)) => true,
        EventKind::Access(_) | EventKind::Other => false,
        EventKind::Modify(ModifyKind::Metadata(MetadataKind::AccessTime)) => false,
        _ => true,
    }
}

/// Whether a worktree event is outside the review: inside the git dir, or a path git ignores.
fn is_ignored(target: &WatchTarget, path: &Path) -> bool {
    let WatchTarget::Worktree { root, git_dir, ignored, .. } = target else { return false };
    let Ok(rel) = path.strip_prefix(root) else { return false };
    if rel.as_os_str().is_empty() {
        return false;
    }
    if rel.starts_with(".git") || path.starts_with(git_dir) {
        return true;
    }
    let posix = rel.to_string_lossy().replace('\\', "/");
    let ignored = ignored();
    if ignored.contains(&posix) || ignored.contains(&format!("{posix}/")) {
        return true;
    }
    // Ignored directories are listed with a trailing slash.
    posix.match_indices('/').any(|(i, _)| ignored.contains(&posix[..=i]))
}

/// Git writes lock files next to refs and the index; ignoring them makes a commit one signal.
fn is_git_lock(target: &WatchTarget, path: &Path) -> bool {
    let (git_dir, common_dir) = target.dirs();
    path.extension().is_some_and(|e| e == "lock") && (path.starts_with(git_dir) || path.starts_with(common_dir))
}

/// What a meta path looks like now: every file under it with its modification time and size.
type Fingerprint = BTreeMap<PathBuf, (Option<SystemTime>, u64)>;

fn fingerprint(paths: &[PathBuf]) -> Fingerprint {
    let mut out = Fingerprint::new();
    let mut stack: Vec<PathBuf> = paths.to_vec();
    while let Some(path) = stack.pop() {
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        if meta.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&path) {
                stack.extend(entries.flatten().map(|e| e.path()));
            }
        } else if path.extension().is_none_or(|e| e != "lock") {
            out.insert(path, (meta.modified().ok(), meta.len()));
        }
    }
    out
}

/// Polls `paths` at full timestamp resolution; notify's poller compares whole seconds, which
/// misses a ref that moves twice within one. The first scan completes before this returns.
async fn poll_meta(paths: Vec<PathBuf>, tx: mpsc::UnboundedSender<Signal>) -> JoinHandle<()> {
    let paths = Arc::new(paths);
    let scan = paths.clone();
    let mut last = tokio::task::spawn_blocking(move || fingerprint(&scan)).await.unwrap_or_default();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(META_POLL).await;
            let scan = paths.clone();
            let Ok(now) = tokio::task::spawn_blocking(move || fingerprint(&scan)).await else { return };
            if now != last && tx.send(Signal::Changed).is_err() {
                return;
            }
            last = now;
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn worktree(git_dir: PathBuf, common_dir: PathBuf) -> WatchTarget {
        let ignored: IgnoredFn = Arc::new(|| Arc::new(HashSet::from(["build/".to_owned(), "secret.txt".to_owned()])));
        WatchTarget::Worktree { root: PathBuf::from("/repo"), git_dir, common_dir, ignored }
    }

    #[test]
    fn polls_head_and_refs_in_refs_mode_and_adds_the_index_in_worktree_mode() {
        let git_dir = Path::new("/repo").join(".git");
        let refs = [git_dir.join("HEAD"), git_dir.join("refs"), git_dir.join("packed-refs")];
        let target = WatchTarget::Refs { git_dir: git_dir.clone(), common_dir: git_dir.clone() };
        assert_eq!(meta_paths(&target), refs);
        let mut with_index = refs.to_vec();
        with_index.push(git_dir.join("index"));
        assert_eq!(meta_paths(&worktree(git_dir.clone(), git_dir.clone())), with_index);
    }

    #[test]
    fn watches_a_linked_worktree_through_its_own_head_and_index_and_the_shared_refs() {
        let git_dir = Path::new("/repo").join(".git");
        let linked = git_dir.join("worktrees").join("wt");
        let mut expected =
            vec![linked.join("HEAD"), git_dir.join("HEAD"), git_dir.join("refs"), git_dir.join("packed-refs")];
        expected.push(linked.join("index"));
        assert_eq!(meta_paths(&worktree(linked, git_dir)), expected);
    }

    #[test]
    fn leaves_out_the_git_dir_and_ignored_paths_and_their_contents() {
        let git_dir = Path::new("/repo").join(".git");
        let target = worktree(git_dir.clone(), git_dir.clone());
        let at = |rel: &str| Path::new("/repo").join(rel);
        assert!(is_ignored(&target, &at(".git/index")));
        assert!(is_ignored(&target, &at("build/out/app.js")));
        assert!(is_ignored(&target, &at("build")));
        assert!(is_ignored(&target, &at("secret.txt")));
        assert!(!is_ignored(&target, &at("src/build.rs")));
        assert!(!is_ignored(&target, Path::new("/repo")));
        assert!(is_git_lock(&target, &git_dir.join("refs/heads/main.lock")));
        assert!(!is_git_lock(&target, &at("Cargo.lock")));
    }
}
