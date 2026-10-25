//! Branches, remotes, and the fetches that bring pull requests into session-owned refs.
use std::collections::HashSet;

use super::exec::ExecOptions;
use super::{GitRepo, WORKTREE};
use crate::error::{GitError, Result};
use crate::protocol::{RefsResponse, RefsResponseRecentItem};

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
        let refs = self.text(&["for-each-ref", "--format=%(refname)", &prefix]).await?;
        let input: String = refs.lines().filter(|r| !r.is_empty()).map(|r| format!("delete {r}\n")).collect();
        if !input.is_empty() {
            let opts = ExecOptions { input: Some(input.as_bytes()), ..Default::default() };
            self.exec(&["update-ref", "--stdin"], opts).await?;
        }
        Ok(())
    }

    /// origin/HEAD → main → master.
    pub async fn default_branch(&self) -> Result<String> {
        if let Ok(out) = self.text(&["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).await {
            let name = out.trim();
            if !name.is_empty() {
                return Ok(name.to_owned());
            }
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
        let args: &[&str] = if rev == "HEAD" {
            &["symbolic-ref", "--quiet", "HEAD"]
        } else {
            &["rev-parse", "--symbolic-full-name", "--verify", "--end-of-options", rev]
        };
        let Ok(out) = self.text(args).await else {
            return Ok(None);
        };
        let name = out.trim();
        Ok((name.starts_with("refs/heads/") || name.starts_with("refs/remotes/")).then(|| name.to_owned()))
    }

    /// Remote branch identity for an exact local or remote branch; expressions and detached HEAD have none.
    pub async fn upstream_branch(&self, rev: &str) -> Result<Option<Upstream>> {
        let Some(name) = self.branch_ref(rev).await? else {
            return Ok(None);
        };
        if name.starts_with("refs/heads/") {
            let out = self
                .text(&["for-each-ref", "--format=%(upstream:remotename)%00%(upstream:remoteref)%00", &name])
                .await?;
            let mut fields = out.split('\0');
            let (remote, upstream) = (fields.next().unwrap_or_default(), fields.next().unwrap_or_default());
            let Some(branch) = upstream.strip_prefix("refs/heads/") else {
                return Ok(None);
            };
            if remote.is_empty() || remote == "." {
                return Ok(None);
            }
            return Ok(Some(Upstream { remote: remote.to_owned(), branch: branch.to_owned() }));
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
        let opts = ExecOptions { ok_codes: &[1], ..Default::default() };
        let out = self.text_with(&["config", "--null", "--get-regexp", r"^remote\..*\.url$"], opts).await?;
        let mut seen = HashSet::new();
        let mut remotes = Vec::new();
        for record in out.split('\0') {
            let Some((key, url)) = record.split_once('\n') else {
                continue;
            };
            let Some(name) = key.strip_prefix("remote.").and_then(|k| k.strip_suffix(".url")) else {
                continue;
            };
            if seen.insert(name.to_owned()) {
                remotes.push(Remote { name: name.to_owned(), url: url.to_owned() });
            }
        }
        Ok(remotes)
    }

    /// Whether commit `sha` is reachable from a ref under one of `prefixes`, from local refs alone.
    /// Anything but a commit (the worktree, a tree) is not.
    pub async fn reachable_from(&self, sha: &str, prefixes: &[String]) -> Result<bool, GitError> {
        if sha == WORKTREE {
            return Ok(false);
        }
        let Some(commit) = self.try_resolve(sha).await? else { return Ok(false) };
        let globs: Vec<String> = prefixes.iter().map(|p| format!("--glob={p}")).collect();
        let mut args = vec!["rev-list", "--max-count=1", "--not"];
        args.extend(globs.iter().map(String::as_str));
        // Lists the commit itself unless one of the refs reaches it.
        args.extend(["--not", "--end-of-options", &commit, "--"]);
        Ok(self.text(&args).await?.trim().is_empty())
    }

    /// Fetches explicit refspecs from `remote` (a name or a URL). The refspecs must stay inside
    /// `refs/diffle/`, so no ref the user owns moves, and FETCH_HEAD is left alone. Terminal prompts
    /// are off: a repository that needs credentials fails instead of hanging.
    pub async fn fetch(&self, remote: &str, refspecs: &[String]) -> Result<(), GitError> {
        for spec in refspecs {
            let dst = spec.split_once(':').map_or(spec.as_str(), |(_, dst)| dst);
            if !dst.starts_with("refs/diffle/") {
                return Err(GitError::refused(format!("refusing to fetch into {dst}"), &["fetch"]));
            }
        }
        let mut args = vec!["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--end-of-options", remote];
        args.extend(refspecs.iter().map(String::as_str));
        self.exec(&args, ExecOptions { env: &[("GIT_TERMINAL_PROMPT", "0")], ..Default::default() }).await?;
        Ok(())
    }

    /// Branches, tags, and recent commits for the mode picker.
    pub async fn refs(&self) -> Result<RefsResponse> {
        let sorted = |order: &'static str, prefix: &'static str| async move {
            self.text(&["for-each-ref", "--format=%(refname:short)", order, prefix]).await
        };
        let (heads, remotes, tags, log, current, default_branch) = tokio::join!(
            sorted("--sort=-committerdate", "refs/heads"),
            sorted("--sort=-committerdate", "refs/remotes"),
            sorted("--sort=-creatordate", "refs/tags"),
            // An unborn branch has no log; the picker still needs the refs.
            self.text(&["log", "-n", "30", "--format=%H%x00%h%x00%s"]),
            self.text(&["rev-parse", "--abbrev-ref", "HEAD"]),
            self.default_branch(),
        );
        let lines = |s: String| s.lines().filter(|l| !l.is_empty()).map(str::to_owned).collect::<Vec<_>>();
        let current = current.ok().map(|s| s.trim().to_owned()).filter(|c| c != "HEAD");
        Ok(RefsResponse {
            default_branch: default_branch.ok(),
            current,
            branches: lines(heads?),
            // `origin/HEAD` shortens to `origin`; drop symbolic remote heads.
            remote_branches: lines(remotes?).into_iter().filter(|r| r.contains('/') && !r.ends_with("/HEAD")).collect(),
            tags: lines(tags?),
            recent: lines(log.unwrap_or_default())
                .into_iter()
                .map(|l| {
                    let mut f = l.splitn(3, '\0').map(str::to_owned);
                    RefsResponseRecentItem {
                        sha: f.next().unwrap_or_default(),
                        short: f.next().unwrap_or_default(),
                        subject: f.next().unwrap_or_default(),
                    }
                })
                .collect(),
        })
    }
}
