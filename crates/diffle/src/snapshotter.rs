//! Turns one review into snapshots: trees, changed files, commits, and their patches.
use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex};

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};

use crate::error::{Error, Result};
use crate::generated::GeneratedFlags;
use crate::git::{GitRepo, WORKTREE};
use crate::iterations::IterationStore;
use crate::mode::view::{Shown, resolve_shown};
use crate::protocol::{
    ChangeStatus, ChangedFile, Iteration, MAX_RANGE_COMMITS, RangeCommits, RangeEnds, Review, ReviewedCommit, Snapshot,
};

/// Patches computed ahead for the first changed files, which the viewer asks for first.
const PREWARM: usize = 3;

type Task<T> = Shared<BoxFuture<'static, Result<T>>>;

struct State {
    version: i64,
    context: u32,
    snapshot: Option<Task<Arc<Snapshot>>>,
    patches: HashMap<String, Task<String>>,
    all: Option<Task<String>>,
}

/// One review's snapshots, cached until `invalidate`. A failed computation is dropped from the cache,
/// so the next caller retries it.
pub struct Snapshotter {
    repo: Arc<GitRepo>,
    pub review: Review,
    /// Where the range's comments live, whatever slice is shown; a lone commit has none.
    range_key: Option<String>,
    /// Records the range's endpoints as taken; absent for reviews that are not followed.
    iterations: Option<IterationStore>,
    state: Mutex<State>,
    generated: GeneratedFlags,
}

impl Snapshotter {
    pub fn new(
        repo: Arc<GitRepo>,
        review: Review,
        range_key: Option<String>,
        version: i64,
        context: u32,
        iterations: Option<IterationStore>,
    ) -> Arc<Self> {
        Arc::new(Self {
            repo,
            review,
            range_key,
            iterations,
            state: Mutex::new(State { version, context, snapshot: None, patches: HashMap::new(), all: None }),
            generated: GeneratedFlags::default(),
        })
    }

    /// Change context lines: drops cached patches; the next snapshot carries the new value.
    pub fn set_context(&self, context: u32, version: i64) {
        let mut state = self.state.lock().unwrap();
        if state.context != context {
            state.context = context;
            drop(state);
            self.invalidate(version);
        }
    }

    pub fn invalidate(&self, version: i64) {
        let mut state = self.state.lock().unwrap();
        state.version = version;
        state.snapshot = None;
        state.patches.clear();
        state.all = None;
    }

    pub async fn current(self: &Arc<Self>) -> Result<Arc<Snapshot>> {
        let (task, version) = {
            let mut state = self.state.lock().unwrap();
            let version = state.version;
            let this = self.clone();
            let task =
                state.snapshot.get_or_insert_with(|| async move { this.compute(version).await }.boxed().shared());
            (task.clone(), version)
        };
        let result = task.await;
        if result.is_err() {
            self.forget(|state| state.version == version, |state| state.snapshot = None);
        }
        result
    }

    /// Clears what `clear` names, if `still` holds: a failure must not evict a newer computation.
    fn forget(&self, still: impl FnOnce(&State) -> bool, clear: impl FnOnce(&mut State)) {
        let mut state = self.state.lock().unwrap();
        if still(&state) {
            clear(&mut state);
        }
    }

    pub async fn patch(self: &Arc<Self>, path: &str) -> Result<Option<String>> {
        let snap = self.current().await?;
        let Some(file) = snap.changed.iter().find(|f| f.path == path) else {
            return Ok(None);
        };
        self.patch_for(&snap, file).await.map(Some)
    }

    /// Every changed file's patch, concatenated. One git call plus untracked files.
    pub async fn patch_all(self: &Arc<Self>) -> Result<String> {
        let snap = self.current().await?;
        let task = {
            let mut state = self.state.lock().unwrap();
            let (repo, context, snap) = (self.repo.clone(), state.context, snap.clone());
            let all = async move { Ok(repo.patch_all(&snap.old_sha, &snap.new_sha, &snap.changed, context).await?) };
            state.all.get_or_insert_with(|| all.boxed().shared()).clone()
        };
        let result = task.clone().await;
        if result.is_err() {
            self.forget(|state| state.all.as_ref().is_some_and(|t| t.ptr_eq(&task)), |state| state.all = None);
        }
        result
    }

    /// Patches for `paths`, concatenated: cached ones as they are, the rest in one git call. Unknown paths are skipped.
    pub async fn patch_many(self: &Arc<Self>, paths: &[String]) -> Result<String> {
        let snap = self.current().await?;
        let by_path: HashMap<&str, &ChangedFile> = snap.changed.iter().map(|f| (f.path.as_str(), f)).collect();
        let (mut cached, mut rest) = (Vec::new(), Vec::new());
        let mut seen = BTreeSet::new();
        {
            let state = self.state.lock().unwrap();
            for path in paths.iter().filter(|p| seen.insert(p.as_str())) {
                let Some(file) = by_path.get(path.as_str()) else {
                    continue;
                };
                match state.patches.get(path) {
                    Some(task) => cached.push(task.clone()),
                    None => rest.push((*file).clone()),
                }
            }
        }
        // One file goes through the per-file cache, so a later single request finds it.
        let batch = async {
            match rest.as_slice() {
                [] => Ok(String::new()),
                [one] => self.patch_for(&snap, one).await,
                _ => {
                    let context = self.state.lock().unwrap().context;
                    Ok(self.repo.patch_many(&snap.old_sha, &snap.new_sha, &rest, context).await?)
                }
            }
        };
        let (cached, batch) = tokio::join!(futures::future::try_join_all(cached), batch);
        Ok(cached?.concat() + &batch?)
    }

    /// The patches of `paths` as `snap` names them, whatever snapshot is current by now: one git
    /// call, concatenated, kept nowhere. Paths `snap` does not change are skipped.
    pub async fn patches_of(&self, snap: &Snapshot, paths: &[String]) -> Result<String> {
        let wanted: BTreeSet<&str> = paths.iter().map(String::as_str).collect();
        let files: Vec<ChangedFile> =
            snap.changed.iter().filter(|f| wanted.contains(f.path.as_str())).cloned().collect();
        let context = u32::try_from(snap.context).unwrap_or_default();
        Ok(self.repo.patch_many(&snap.old_sha, &snap.new_sha, &files, context).await?)
    }

    fn patch_for(
        self: &Arc<Self>,
        snap: &Arc<Snapshot>,
        file: &ChangedFile,
    ) -> impl Future<Output = Result<String>> + use<> {
        let task = {
            let mut state = self.state.lock().unwrap();
            let context = state.context;
            let (repo, snap, file) = (self.repo.clone(), snap.clone(), file.clone());
            state
                .patches
                .entry(file.path.clone())
                .or_insert_with(|| {
                    async move { Ok(repo.patch(&snap.old_sha, &snap.new_sha, &file, context, None).await?) }
                        .boxed()
                        .shared()
                })
                .clone()
        };
        let (this, path) = (self.clone(), file.path.clone());
        async move {
            let result = task.clone().await;
            if result.is_err() {
                this.forget(
                    |state| state.patches.get(&path).is_some_and(|t| t.ptr_eq(&task)),
                    |state| {
                        state.patches.remove(&path);
                    },
                );
            }
            result
        }
    }

    async fn compute(self: Arc<Self>, version: i64) -> Result<Arc<Snapshot>> {
        let repo = &self.repo;
        let shown = resolve_shown(repo, &self.review, self.iterations.as_ref(), self.range_key.as_deref());
        let (shown, head_sha) = tokio::join!(shown, repo.resolve("HEAD"));
        let (shown, head_sha) = (shown?, head_sha.unwrap_or_default());
        let Shown { old_sha, new_sha, follows, range, interdiff, commit, comment_key } = shown;
        // The tree belongs to the selected new side: a commit's own listing, or the index plus
        // untracked files (added below via `changed`) for the worktree.
        let tracked = async {
            if new_sha == WORKTREE {
                let (files, untracked) = tokio::try_join!(repo.ls_files(), repo.untracked())?;
                Ok::<_, Error>(files.into_iter().chain(untracked).filter(|p| !p.ends_with('/')).collect::<Vec<_>>())
            } else {
                Ok(repo.ls_tree(&new_sha).await?)
            }
        };
        let commit = async {
            match &commit {
                Some(sha) => self.reviewed_commit(sha).await,
                None => Ok(None),
            }
        };
        let (tracked, mut changed, commit, commits) =
            tokio::try_join!(tracked, repo.numstat(&old_sha, &new_sha), commit, self.range_commits(&range, &head_sha))?;
        let (iterations, ()) =
            tokio::join!(self.record_iteration(&commits), self.generated.fill(repo, &mut changed, &new_sha));
        let mut tree: BTreeSet<String> = tracked.into_iter().collect();
        for f in &changed {
            if f.status == ChangeStatus::D {
                tree.remove(&f.path);
            } else {
                tree.insert(f.path.clone());
            }
            if let Some(old) = &f.old_path {
                tree.remove(old);
            }
        }
        let context = self.state.lock().unwrap().context;
        let snap = Arc::new(Snapshot {
            root: repo.root.to_string_lossy().into_owned(),
            review: self.review.clone(),
            version,
            old_sha,
            new_sha,
            head_sha,
            follows,
            comment_key,
            interdiff,
            context: i64::from(context),
            changed,
            tree: tree.into_iter().collect(),
            commit,
            commits,
            iterations: iterations?,
        });
        for f in snap.changed.iter().take(PREWARM) {
            tokio::spawn(self.patch_for(&snap, f));
        }
        Ok(snap)
    }

    /// The snapshot taken is the range's current iteration; the worktree has no commit to record.
    async fn record_iteration(&self, commits: &RangeCommits) -> Result<Vec<Iteration>> {
        match &self.iterations {
            Some(store) if commits.old_sha != WORKTREE && commits.new_sha != WORKTREE => {
                Ok(store.record(&commits.old_sha, &commits.new_sha).await?)
            }
            _ => Ok(Vec::new()),
        }
    }

    async fn reviewed_commit(&self, sha: &str) -> Result<Option<ReviewedCommit>> {
        let (info, neighbours) = tokio::try_join!(self.repo.commit_info(sha), self.repo.commit_neighbours(sha))?;
        Ok(info.map(|info| ReviewedCommit {
            sha: info.sha,
            short: info.short,
            message: info.message,
            parent: neighbours.0,
            child: neighbours.1,
        }))
    }

    /// The commits the review's range spans; a lone commit lists itself.
    async fn range_commits(&self, range: &RangeEnds, head_sha: &str) -> Result<RangeCommits> {
        if let Review::Commit { sha } = &self.review {
            let list = self.repo.range_commits(&format!("{sha}^!"), MAX_RANGE_COMMITS).await?;
            return Ok(RangeCommits {
                list: list.list,
                total: list.total,
                old_sha: range.old_sha.clone(),
                new_sha: range.new_sha.clone(),
            });
        }
        self.spanned(&range.old_sha, &range.new_sha, head_sha).await
    }

    async fn spanned(&self, old_sha: &str, new_sha: &str, head_sha: &str) -> Result<RangeCommits> {
        let side = |sha: &str| {
            if sha == WORKTREE { head_sha.to_owned() } else { sha.to_owned() }
        };
        let (from, to) = (side(old_sha), side(new_sha));
        // An unborn branch has no commits; its old side is then the empty tree, which no range can name.
        let (list, total) = if from.is_empty() || to.is_empty() || from == to {
            (Vec::new(), 0)
        } else {
            let commits = self.repo.range_commits(&format!("{from}..{to}"), MAX_RANGE_COMMITS).await?;
            (commits.list, commits.total)
        };
        Ok(RangeCommits { list, total, old_sha: old_sha.into(), new_sha: new_sha.into() })
    }
}
