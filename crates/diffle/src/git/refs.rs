//! Branches, remotes, and the fetches that bring pull requests into session-owned refs.
use std::collections::HashSet;

use gix::ObjectId;
use gix::bstr::ByteSlice;
use gix::objs::Kind;
use gix::refs::transaction::{PreviousValue, RefEdit};
use gix::revision::walk::Sorting;
use gix::traverse::commit::simple::CommitTimeOrder;

use super::{GitRepo, WORKTREE};
use crate::error::{GitError, Result};
use crate::protocol::{RefsResponse, RefsResponseRecentItem};

/// How many of HEAD's commits the mode picker offers.
const RECENT: usize = 30;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Remote {
    pub name: String,
    pub url: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Upstream {
    pub remote: String,
    pub branch: String,
}

impl GitRepo {
    /// Remove only refs owned by this review, never another running instance's.
    pub async fn clean_review_refs(&self) -> Result<(), GitError> {
        let prefix = format!("{}/", self.review_refs);
        self.gix("deleting review refs", move |repo| {
            let names: Vec<String> = repo
                .references()?
                .prefixed(prefix.as_str())?
                .map(|r| Ok(r?.name().as_bstr().to_string()))
                .collect::<anyhow::Result<_>>()?;
            let edits = names.iter().map(|name| delete(name)).collect::<anyhow::Result<Vec<_>>>()?;
            if !edits.is_empty() {
                repo.edit_references(edits)?;
            }
            Ok(())
        })
        .await
    }

    /// origin/HEAD → main → master.
    pub async fn default_branch(&self) -> Result<String> {
        let origin_head = self
            .gix("reading origin/HEAD", |repo| {
                let Some(head) = repo.try_find_reference("refs/remotes/origin/HEAD").ok().flatten() else {
                    return Ok(None);
                };
                Ok(head.target().try_name().map(|name| name.shorten().to_string()))
            })
            .await;
        if let Ok(Some(name)) = origin_head {
            return Ok(name);
        }
        for candidate in ["origin/main", "origin/master", "main", "master"] {
            if self.resolve(candidate).await.is_ok() {
                return Ok(candidate.to_owned());
            }
        }
        Err(GitError::refused("cannot determine default branch; pass a base explicitly", &[]).into())
    }

    /// Full ref for an exact branch; expressions, worktree, and detached HEAD have none.
    pub async fn branch_ref(&self, rev: &str) -> Result<Option<String>> {
        if rev == WORKTREE {
            return Ok(None);
        }
        let rev = rev.to_owned();
        let name = self
            .gix("resolving a branch", move |repo| {
                if rev == "HEAD" {
                    return Ok(repo.head_name()?.map(|name| name.as_bstr().to_string()));
                }
                // A name that is not a valid ref (`main~1`) names no branch.
                Ok(repo.try_find_reference(rev.as_str()).ok().flatten().map(|r| r.name().as_bstr().to_string()))
            })
            .await?;
        Ok(name.filter(|name| name.starts_with("refs/heads/") || name.starts_with("refs/remotes/")))
    }

    /// Remote branch identity for an exact local or remote branch; expressions and detached HEAD have none.
    pub async fn upstream_branch(&self, rev: &str) -> Result<Option<Upstream>> {
        let Some(name) = self.branch_ref(rev).await? else {
            return Ok(None);
        };
        if let Some(short) = name.strip_prefix("refs/heads/") {
            let short = short.to_owned();
            let (remote, upstream) = self
                .gix("reading the upstream", move |repo| {
                    let config = current_config(repo)?;
                    let config = config.config_snapshot();
                    let value = |key: &str| config.string(&format!("branch.{short}.{key}")).map(|v| v.to_string());
                    Ok((value("remote").unwrap_or_default(), value("merge").unwrap_or_default()))
                })
                .await?;
            let Some(branch) = upstream.strip_prefix("refs/heads/") else {
                return Ok(None);
            };
            if remote.is_empty() || remote == "." {
                return Ok(None);
            }
            return Ok(Some(Upstream { remote, branch: branch.to_owned() }));
        }
        // Remote names can contain slashes; match the longest configured name.
        let mut remotes = self.remotes().await?;
        remotes.sort_by_key(|r| std::cmp::Reverse(r.name.len()));
        Ok(remotes.into_iter().find_map(|r| {
            let branch = name.strip_prefix(&format!("refs/remotes/{}/", r.name))?.to_owned();
            Some(Upstream { remote: r.name, branch })
        }))
    }

    /// Configured remotes, in git's order, with their fetch URLs as configured: before `insteadOf`
    /// rewriting, which can hide the repository's identity.
    pub async fn remotes(&self) -> Result<Vec<Remote>, GitError> {
        self.gix("reading remotes", |repo| {
            let config = current_config(repo)?;
            let mut seen = HashSet::new();
            let mut remotes = Vec::new();
            for section in config.config_snapshot().plumbing().sections_by_name("remote").into_iter().flatten() {
                let (Some(name), Some(url)) =
                    (section.header().subsection_name(), section.values("url").into_iter().next())
                else {
                    continue;
                };
                let name = name.to_string();
                if seen.insert(name.clone()) {
                    remotes.push(Remote { name, url: url.to_string() });
                }
            }
            Ok(remotes)
        })
        .await
    }

    /// Branches, tags, and recent commits for the mode picker.
    pub async fn refs(&self) -> Result<RefsResponse> {
        let listed = self.gix("listing refs", |repo| {
            let heads = sorted(repo, "refs/heads/", Date::Committer)?;
            // `origin/HEAD` names no branch of its own.
            let remotes = sorted(repo, "refs/remotes/", Date::Committer)?;
            let remotes = remotes.into_iter().filter(|r| r.contains('/') && !r.ends_with("/HEAD")).collect();
            let tags = sorted(repo, "refs/tags/", Date::Creator)?;
            let head = repo.head()?;
            let current = (!head.is_detached() && !head.is_unborn())
                .then(|| head.referent_name().map(|n| n.shorten().to_string()))
                .flatten();
            Ok((heads, remotes, tags, current, recent(repo).unwrap_or_default()))
        });
        let (listed, default_branch) = tokio::join!(listed, self.default_branch());
        let (branches, remote_branches, tags, current, recent) = listed?;
        Ok(RefsResponse { default_branch: default_branch.ok(), current, branches, remote_branches, tags, recent })
    }
}

/// Config as it is on disk now: the shared handle keeps what was read when the repository opened.
pub(super) fn current_config(repo: &gix::Repository) -> gix::Result<gix::Repository> {
    gix::open(repo.workdir().unwrap_or(repo.git_dir()))
}

/// A ref update that never moves anything outside what the caller validated.
pub(super) fn update(name: &str, id: ObjectId) -> anyhow::Result<RefEdit> {
    Ok(RefEdit::update(name.try_into()?, id, PreviousValue::Any, "diffle"))
}

pub(super) fn delete(name: &str) -> anyhow::Result<RefEdit> {
    Ok(RefEdit::delete(name.try_into()?, PreviousValue::Any))
}

#[derive(Clone, Copy)]
enum Date {
    Committer,
    /// A tag's own date when annotated, else its commit's.
    Creator,
}

/// Short names under `prefix`, newest first and by name among equals, as `for-each-ref --sort=-<date>`.
fn sorted(repo: &gix::Repository, prefix: &str, date: Date) -> anyhow::Result<Vec<String>> {
    // Collected before peeling: the iterator holds the packed refs.
    let refs: Vec<gix::refs::FullName> =
        repo.references()?.prefixed(prefix)?.filter_map(|r| Some(r.ok()?.detach().name)).collect();
    let time = |id: ObjectId| -> Option<i64> {
        let object = repo.find_object(id).ok()?;
        if let (Date::Creator, Kind::Tag) = (date, object.kind) {
            return object.into_tag().tagger().ok().flatten().map(|t| t.seconds());
        }
        object.peel_to_commit().ok()?.time().ok().map(|t| t.seconds)
    };
    let mut dated: Vec<(i64, String)> = refs
        .into_iter()
        .map(|name| {
            // A symbolic ref sorts by what it points at.
            let id = repo.find_reference(name.as_ref()).ok().and_then(|mut r| r.follow_to_object().ok());
            (id.map(gix::Id::detach).and_then(time).unwrap_or(0), name.as_ref().shorten().to_string())
        })
        .collect();
    dated.sort_by_key(|(time, _)| std::cmp::Reverse(*time));
    Ok(dated.into_iter().map(|(_, name)| name).collect())
}

/// HEAD's newest commits; none on an unborn branch.
fn recent(repo: &gix::Repository) -> anyhow::Result<Vec<RefsResponseRecentItem>> {
    let walk = repo.head_id()?.ancestors().sorting(Sorting::ByCommitTime(CommitTimeOrder::NewestFirst)).all()?;
    walk.take(RECENT)
        .map(|info| {
            let commit = info?.object()?;
            Ok(RefsResponseRecentItem {
                sha: commit.id.to_string(),
                short: commit.id().shorten_or_id().to_string(),
                subject: commit.message()?.summary().to_str_lossy().into_owned(),
            })
        })
        .collect()
}
