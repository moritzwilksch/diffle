//! The review told as a story: the changed files grouped into parts a reader follows in order,
//! each with a narrative, written by a model on request and kept under `<git-dir>/diffle/stories/`
//! by the content it describes.
pub mod client;
mod prompt;
mod validate;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use sha1::{Digest, Sha1};

use crate::error::{Result, StoryError};
use crate::persist::write_file_atomic;
use crate::protocol::{ServerMessage, Snapshot, Story, StoryState, StoryStatus};
use crate::session::{Broadcaster, Session};
use client::StoryModel;

#[derive(Default)]
struct State {
    /// The fingerprint a story is being written for.
    generating: Option<String>,
    /// The last failure: its fingerprint and message.
    failed: Option<(String, String)>,
    /// The latest story written or read this run, whatever it describes.
    latest: Option<Story>,
}

/// Owns the stories of one session's reviews: at most one in the writing, the rest on disk.
pub struct StoryService {
    session: Arc<Session>,
    hub: Arc<dyn Broadcaster>,
    /// The model, or why there is none.
    model: std::result::Result<Arc<dyn StoryModel>, String>,
    state: Mutex<State>,
}

impl StoryService {
    pub fn new(
        session: Arc<Session>,
        hub: Arc<dyn Broadcaster>,
        model: std::result::Result<Arc<dyn StoryModel>, String>,
    ) -> Arc<Self> {
        Arc::new(Self { session, hub, model, state: Mutex::default() })
    }

    /// The story of the current snapshot: on record, in the writing, failed, or absent, with the
    /// latest one marked stale when it describes other content.
    pub async fn state(&self) -> Result<StoryState> {
        let snap = self.session.snapshotter()?.current().await?;
        let fp = fingerprint(&snap);
        let blocker = self.blocker(&snap);
        let (generating, failed, latest) = {
            let state = self.state.lock().unwrap();
            (state.generating.clone(), state.failed.clone(), state.latest.clone())
        };
        let on_record = match latest.as_ref().filter(|s| s.fingerprint == fp) {
            Some(story) => Some(story.clone()),
            None => self.read(&fp).await,
        };
        if let Some(story) = &on_record {
            self.state.lock().unwrap().latest = Some(story.clone());
        }
        let (status, error) = if generating.as_deref() == Some(&fp) {
            (StoryStatus::Generating, None)
        } else if on_record.is_some() {
            (StoryStatus::Ready, None)
        } else if let Some((_, message)) = failed.filter(|(at, _)| *at == fp) {
            (StoryStatus::Failed, Some(message))
        } else {
            (StoryStatus::Absent, None)
        };
        let stale = on_record.is_none() && latest.is_some();
        Ok(StoryState { version: snap.version, status, blocker, error, story: on_record.or(latest), stale })
    }

    /// Starts writing the current snapshot's story unless one is on record or in the writing, and
    /// answers the state as it is then. The outcome is broadcast as `story`.
    pub async fn generate(self: &Arc<Self>) -> Result<StoryState> {
        let snap = self.session.snapshotter()?.current().await?;
        if let Some(blocker) = self.blocker(&snap) {
            return Err(StoryError::conflict(blocker).into());
        }
        let model = self.model.clone().expect("a model when nothing blocks");
        let fp = fingerprint(&snap);
        let started = {
            let mut state = self.state.lock().unwrap();
            let on_record = state.latest.as_ref().is_some_and(|s| s.fingerprint == fp);
            if state.generating.is_some() || on_record {
                false
            } else {
                state.generating = Some(fp.clone());
                state.failed = None;
                true
            }
        };
        if started {
            let this = self.clone();
            tokio::spawn(async move {
                let outcome = this.write(&snap, model, &fp).await;
                {
                    let mut state = this.state.lock().unwrap();
                    state.generating = None;
                    match outcome {
                        Ok(story) => state.latest = Some(story),
                        Err(e) => state.failed = Some((fp.clone(), e.message)),
                    }
                }
                this.hub.broadcast(ServerMessage::Story);
            });
            self.hub.broadcast(ServerMessage::Story);
        }
        self.state().await
    }

    async fn write(
        &self,
        snap: &Arc<Snapshot>,
        model: Arc<dyn StoryModel>,
        fp: &str,
    ) -> std::result::Result<Story, StoryError> {
        let paths: Vec<String> =
            snap.changed.iter().filter(|f| !f.generated && !f.binary).map(|f| f.path.clone()).collect();
        let patches = self
            .session
            .snapshotter()
            .map_err(|e| StoryError::conflict(e.to_string()))?
            .patch_many(&paths)
            .await
            .map_err(|e| StoryError::upstream(format!("cannot read the patches: {e}")))?;
        let answer = model.complete(prompt::build(snap, &patches)).await?;
        let story = validate::assemble(answer.json, snap, answer.model, fp.to_owned())?;
        if let Err(e) = self.persist(&story).await {
            crate::status!("[diffle] cannot keep the story: {e:#}");
        }
        Ok(story)
    }

    fn blocker(&self, snap: &Snapshot) -> Option<String> {
        match &self.model {
            Err(why) => Some(why.clone()),
            Ok(_) if snap.changed.is_empty() => Some("No changes to tell".to_owned()),
            Ok(_) => None,
        }
    }

    fn file(&self, fp: &str) -> PathBuf {
        self.session.repo.git_dir.join("diffle").join("stories").join(format!("{fp}.json"))
    }

    async fn read(&self, fp: &str) -> Option<Story> {
        let text = tokio::fs::read_to_string(self.file(fp)).await.ok()?;
        serde_json::from_str(&text).ok().filter(|s: &Story| s.fingerprint == fp)
    }

    async fn persist(&self, story: &Story) -> anyhow::Result<()> {
        write_file_atomic(&self.file(&story.fingerprint), &serde_json::to_string_pretty(story)?).await
    }
}

/// What a story describes: the endpoints and every changed file's blobs, so worktree edits and
/// pushes make a new one and a reopened review finds the old.
pub fn fingerprint(snap: &Snapshot) -> String {
    let mut hasher = Sha1::new();
    hasher.update(snap.old_sha.as_bytes());
    hasher.update(b"\0");
    hasher.update(snap.new_sha.as_bytes());
    for f in &snap.changed {
        hasher.update(b"\0");
        hasher.update(f.path.as_bytes());
        hasher.update(b"\0");
        hasher.update(f.old_blob.as_bytes());
        hasher.update(b"\0");
        hasher.update(f.blob.as_bytes());
    }
    hex::encode(hasher.finalize())
}
