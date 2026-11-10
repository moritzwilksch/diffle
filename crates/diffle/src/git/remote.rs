//! Bringing commits in: pull requests fetched into session-owned refs, and foreign repositories
//! cloned. Network remotes go through gix's client; a remote that is a local path is read
//! directly (`local.rs`).
use std::path::Path;
use std::sync::atomic::AtomicBool;

use anyhow::Context;
use gix::ObjectId;
use gix::bstr::ByteSlice;
use gix::refs::transaction::{Change, LogChange, PreviousValue, RefEdit, RefLog};
use gix::remote::Direction;

use super::{GitRepo, local, refs};
use crate::error::{GitError, Result};

/// Where cloned branches are tracked, as `git clone` sets it up.
const TRACKING: &str = "+refs/heads/*:refs/remotes/origin/*";

impl GitRepo {
    /// Fetches explicit refspecs from `remote` (a name or a URL). The refspecs must stay inside
    /// `refs/diffle/`, so no ref the user owns moves; no tags come along and FETCH_HEAD is left
    /// alone. Credentials come from the configured helpers, never a prompt: a repository that
    /// needs one fails instead of hanging.
    pub async fn fetch(&self, remote: &str, refspecs: &[String]) -> Result<()> {
        for spec in refspecs {
            let dst = spec.split_once(':').map_or(spec.as_str(), |(_, dst)| dst);
            if !dst.starts_with("refs/diffle/") {
                return Err(GitError::new(format!("refusing to fetch into {dst}")).into());
            }
        }
        let (remote, refspecs) = (remote.to_owned(), refspecs.to_vec());
        self.gix("fetch", move |repo| {
            // Remotes and `insteadOf` rewrites as configured now, not when the repository opened.
            let mut repo = refs::current_config(repo)?;
            // A remote that is gone, refuses, or lacks the ref is the user's to fix.
            fetch_into(&mut repo, &remote, &refspecs, false)
                .map_err(|e| GitError::new(format!("fetching from {remote} failed: {e:#}")))?;
            Ok(())
        })
        .await
    }

    /// Clones `url` into the empty `dir` with its full history, which merge bases need, and checks
    /// out its default branch. No tags come along.
    pub async fn clone_into(url: &str, dir: &Path) -> Result<Self> {
        let (owned, path) = (url.to_owned(), dir.to_owned());
        tokio::task::spawn_blocking(move || clone(&owned, &path))
            .await
            .map_err(anyhow::Error::from)?
            .map_err(|e| GitError::new(format!("cloning {url} failed: {e:#}")))?;
        Self::open(dir).await
    }
}

/// Fetches `refspecs` (`+src:dst`, or `+prefix/*:prefix/*`) from `remote`. With `head`, also asks
/// which branch the remote's HEAD names and returns its full name.
fn fetch_into(
    repo: &mut gix::Repository,
    remote: &str,
    refspecs: &[String],
    head: bool,
) -> anyhow::Result<Option<String>> {
    // Reflogs of remote-tracking refs need a committer, which a fresh clone may lack.
    repo.committer_or_set_fallback("diffle", "diffle@localhost")?;
    let repo = &*repo;
    let mut remote = match repo.find_remote(remote) {
        Ok(found) => found,
        Err(_) => repo.remote_at(remote)?,
    };
    if let Some(path) = on_disk(repo, &remote)? {
        return local::copy_refs(repo, &path, refspecs);
    }
    let url = remote.url(Direction::Fetch).context("the remote has no url")?.clone();
    remote.replace_refspecs(refspecs.iter().map(String::as_str), Direction::Fetch)?;
    let remote = remote.with_fetch_tags(gix::remote::fetch::Tags::None);
    let (mut helpers, _, mut prompt) = repo.config_snapshot().credential_helpers(url)?;
    prompt.mode = gix::prompt::Mode::Disable;
    let mut connection = remote.connect(Direction::Fetch)?;
    connection.set_credentials(move |action| helpers.invoke(action, prompt.clone()));
    let mut options = gix::remote::ref_map::Options::default();
    if head {
        // The server lists only refs the refspecs could match; HEAD rides along without being written.
        options
            .extra_refspecs
            .push(gix::refspec::parse("HEAD".into(), gix::refspec::parse::Operation::Fetch)?.to_owned());
    }
    let outcome = connection
        .prepare_fetch(gix::progress::Discard, options)?
        .receive(gix::progress::Discard, &AtomicBool::new(false))?;
    Ok(outcome.ref_map.remote_refs.iter().find_map(|r| match r {
        gix::protocol::handshake::Ref::Symbolic { full_ref_name, target, .. } if full_ref_name == "HEAD" => {
            Some(target.to_string())
        }
        _ => None,
    }))
}

/// Where `remote` is when it is a repository on disk, its `insteadOf` rewrites applied. A relative
/// path is the repository's, as git runs a fetch from the top of its worktree.
fn on_disk(repo: &gix::Repository, remote: &gix::Remote<'_>) -> anyhow::Result<Option<std::path::PathBuf>> {
    let url = remote.url(Direction::Fetch).context("the remote has no url")?;
    if url.scheme != gix::url::Scheme::File {
        return Ok(None);
    }
    let base = repo.workdir().unwrap_or_else(|| repo.git_dir());
    Ok(Some(base.join(gix::path::from_bstr(url.path.as_bstr())?)))
}

/// `git clone --no-tags url dir`: a repository whose `origin` is `url`, its branches tracked, and
/// the default branch checked out. Not `gix::prepare_clone`: a local path, `insteadOf` included,
/// would spawn `git-upload-pack`, so one path serves both kinds of URL and the tests cover it.
fn clone(url: &str, dir: &Path) -> anyhow::Result<()> {
    let repo = gix::init(dir)?;
    let config_path = repo.git_dir().join("config");
    let mut config = gix::config::File::from_path_no_includes(config_path.clone(), gix::config::Source::Local)?;
    let mut origin = repo.remote_at(url)?.with_fetch_tags(gix::remote::fetch::Tags::None);
    origin.replace_refspecs([TRACKING], Direction::Fetch)?;
    origin.save_as_to("origin", &mut config)?;
    std::fs::write(&config_path, config.to_bstring())?;
    let mut repo = gix::open(dir)?;
    // A repository on disk lends its objects, as `git clone` links them; the fetch then sends none.
    if let Some(path) = on_disk(&repo, &repo.find_remote("origin")?)? {
        let source = gix::open(&path).with_context(|| format!("{} is not a repository", path.display()))?;
        local::link_objects(&source, &repo)?;
    }
    let head = fetch_into(&mut repo, "origin", &[TRACKING.to_owned()], true)?;
    let Some(branch) = head.as_deref().and_then(|h| h.strip_prefix("refs/heads/")).map(str::to_owned) else {
        return Ok(());
    };
    let id = repo.find_reference(format!("refs/remotes/origin/{branch}").as_str())?.peel_to_id()?.detach();
    let local = format!("refs/heads/{branch}");
    let head_edit = RefEdit {
        change: Change::Update {
            log: LogChange { mode: RefLog::AndReference, force_create_reflog: false, message: "clone".into() },
            expected: PreviousValue::Any,
            new: gix::refs::Target::Symbolic(local.as_str().try_into()?),
        },
        name: "HEAD".try_into()?,
        deref: false,
    };
    repo.edit_references([refs::update(&local, id)?, head_edit])?;
    let mut config = gix::config::File::from_path_no_includes(config_path.clone(), gix::config::Source::Local)?;
    config.set_raw_value_by("branch", Some(branch.as_str().into()), "remote", "origin")?;
    config.set_raw_value_by("branch", Some(branch.as_str().into()), "merge", local.as_str())?;
    std::fs::write(&config_path, config.to_bstring())?;
    checkout(&repo, id)
}

/// Writes `commit`'s tree into the empty worktree and the index to match.
fn checkout(repo: &gix::Repository, commit: ObjectId) -> anyhow::Result<()> {
    let workdir = repo.workdir().context("a bare repository has no worktree")?;
    let tree = repo.find_commit(commit)?.tree_id()?;
    let mut index = repo.index_from_tree(&tree)?;
    let mut options = repo.checkout_options(gix::worktree::stack::state::attributes::Source::IdMapping)?;
    options.destination_is_initially_empty = true;
    let progress = gix::progress::Discard;
    let objects = repo.objects.clone().into_arc()?;
    gix::worktree::state::checkout(
        &mut index,
        workdir,
        objects,
        &progress,
        &progress,
        &AtomicBool::new(false),
        options,
    )?;
    index.write(Default::default())?;
    Ok(())
}
