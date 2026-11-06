//! Bringing commits in: pull requests fetched into session-owned refs, and foreign repositories
//! cloned. Network remotes go through gix's client; a remote that is a local path is read directly.
use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::AtomicBool;

use anyhow::Context;
use gix::ObjectId;
use gix::bstr::ByteSlice;
use gix::objs::{Kind, Write};
use gix::refs::transaction::{Change, LogChange, PreviousValue, RefEdit, RefLog};
use gix::remote::Direction;

use super::{GitRepo, refs};
use crate::error::{GitError, Result};

/// Where cloned branches are tracked, as `git clone` sets it up.
const TRACKING: &str = "+refs/heads/*:refs/remotes/origin/*";

impl GitRepo {
    /// Fetches explicit refspecs from `remote` (a name or a URL). The refspecs must stay inside
    /// `refs/diffle/`, so no ref the user owns moves; no tags come along and FETCH_HEAD is left
    /// alone. Credentials come from the configured helpers, never a prompt: a repository that
    /// needs one fails instead of hanging.
    pub async fn fetch(&self, remote: &str, refspecs: &[String]) -> Result<(), GitError> {
        for spec in refspecs {
            let dst = spec.split_once(':').map_or(spec.as_str(), |(_, dst)| dst);
            if !dst.starts_with("refs/diffle/") {
                return Err(GitError::refused(format!("refusing to fetch into {dst}"), &["fetch"]));
            }
        }
        let (remote, refspecs) = (remote.to_owned(), refspecs.to_vec());
        self.gix("fetch", move |repo| {
            // Remotes and `insteadOf` rewrites as configured now, not when the repository opened.
            let mut repo = refs::current_config(repo)?;
            fetch_into(&mut repo, &remote, &refspecs, false)?;
            Ok(())
        })
        .await
    }

    /// Clones `url` into the empty `dir` with its full history, which merge bases need, and checks
    /// out its default branch. No tags come along.
    pub async fn clone_into(url: &str, dir: &Path) -> Result<Self> {
        let (owned, path) = (url.to_owned(), dir.to_owned());
        let failed = |e: &dyn std::fmt::Display| GitError::refused(format!("cloning {url} failed: {e:#}"), &["clone"]);
        tokio::task::spawn_blocking(move || clone(&owned, &path))
            .await
            .map_err(|e| failed(&e))?
            .map_err(|e| failed(&e))?;
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
    let url = remote.url(Direction::Fetch).context("the remote has no url")?.clone();
    if url.scheme == gix::url::Scheme::File {
        return copy_refs(repo, &gix::path::from_bstr(url.path.as_bstr())?, refspecs);
    }
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

/// A fetch from a repository on disk: its objects the refs need are copied over, then the refs
/// updated, without a `git-upload-pack` to talk to.
fn copy_refs(repo: &gix::Repository, path: &Path, refspecs: &[String]) -> anyhow::Result<Option<String>> {
    let source = gix::open(path).with_context(|| format!("{} is not a repository", path.display()))?;
    let mut edits = Vec::new();
    for spec in refspecs {
        let spec = spec.trim_start_matches('+');
        let (src, dst) = spec.split_once(':').unwrap_or((spec, spec));
        let wanted: Vec<(String, ObjectId)> = match (src.strip_suffix('*'), dst.strip_suffix('*')) {
            (Some(src), Some(dst)) => {
                let names: Vec<String> = source
                    .references()?
                    .prefixed(src)?
                    .filter_map(Result::ok)
                    .map(|r| r.name().as_bstr().to_string())
                    .collect();
                names
                    .into_iter()
                    .map(|name| {
                        let id = source.find_reference(name.as_str())?.peel_to_id()?.detach();
                        Ok((format!("{dst}{}", &name[src.len()..]), id))
                    })
                    .collect::<anyhow::Result<_>>()?
            }
            _ => {
                let mut found =
                    source.find_reference(src).with_context(|| format!("couldn't find remote ref {src}"))?;
                vec![(dst.to_owned(), found.peel_to_id()?.detach())]
            }
        };
        for (dst, id) in wanted {
            copy_reachable(&source, repo, id)?;
            edits.push(refs::update(&dst, id)?);
        }
    }
    if !edits.is_empty() {
        repo.edit_references(edits)?;
    }
    Ok(source.head_name()?.map(|name| name.as_bstr().to_string()))
}

/// Writes the objects reachable from `tip` that `target` lacks; a commit it has brings its history.
fn copy_reachable(source: &gix::Repository, target: &gix::Repository, tip: ObjectId) -> anyhow::Result<()> {
    let (mut pending, mut seen) = (vec![tip], HashSet::new());
    while let Some(id) = pending.pop() {
        if !seen.insert(id) || target.has_object(id) {
            continue;
        }
        let object = source.find_object(id)?;
        match object.kind {
            Kind::Commit => {
                let commit = object.clone().into_commit();
                pending.extend(commit.parent_ids().map(gix::Id::detach));
                copy_tree(source, target, commit.tree_id()?.detach())?;
            }
            Kind::Tag => pending.push(object.clone().into_tag().target_id()?.detach()),
            Kind::Tree => copy_tree(source, target, id)?,
            Kind::Blob => {}
        }
        target.write_buf(object.kind, &object.data)?;
    }
    Ok(())
}

fn copy_tree(source: &gix::Repository, target: &gix::Repository, id: ObjectId) -> anyhow::Result<()> {
    if target.has_object(id) {
        return Ok(());
    }
    let tree = source.find_tree(id)?;
    for entry in tree.iter() {
        let entry = entry?;
        let (mode, oid) = (entry.mode(), entry.oid().to_owned());
        if mode.is_tree() {
            copy_tree(source, target, oid)?;
        } else if !mode.is_commit() && !target.has_object(oid) {
            target.write_buf(Kind::Blob, &source.find_object(oid)?.data)?;
        }
    }
    target.write_buf(Kind::Tree, &tree.data)?;
    Ok(())
}

/// `git clone --no-tags url dir`: a repository whose `origin` is `url`, its branches tracked, and
/// the default branch checked out.
fn clone(url: &str, dir: &Path) -> anyhow::Result<()> {
    let repo = gix::init(dir)?;
    let config_path = repo.git_dir().join("config");
    let mut config = gix::config::File::from_path_no_includes(config_path.clone(), gix::config::Source::Local)?;
    let mut origin = repo.remote_at(url)?.with_fetch_tags(gix::remote::fetch::Tags::None);
    origin.replace_refspecs([TRACKING], Direction::Fetch)?;
    origin.save_as_to("origin", &mut config)?;
    std::fs::write(&config_path, config.to_bstring())?;
    let mut repo = gix::open(dir)?;
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
