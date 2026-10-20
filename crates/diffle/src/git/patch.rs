//! Unified diffs for the viewer: one file, a batch, or every changed file.
use std::collections::HashSet;
use std::sync::LazyLock;

use regex::{Captures, Regex};

use super::exec::ExecOptions;
use super::{GitRepo, READ_CONCURRENCY, WORKTREE, diff_range};
use crate::concurrency::map_limit;
use crate::error::GitError;
use crate::protocol::{ChangeStatus, ChangedFile};

/// Git quotes each side of a header on its own, so the added side's quoting is mirrored rather than assumed absent.
static ADDED_HEADER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?m)^diff --git "?a/dev/null"? ("?)b/(.*)$"#).unwrap());
static DELETED_HEADER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?m)^diff --git ("?)a/(.*) "?b/dev/null"?$"#).unwrap());

/// Fixed header prefixes and no `diff.external`, so a patch is always a unified diff.
fn patch_args(old: &str) -> [&'static str; 3] {
    // -R swaps Git's prefixes too; keep the rendered old/new sides named a/b.
    if old == WORKTREE {
        ["--no-ext-diff", "--src-prefix=b/", "--dst-prefix=a/"]
    } else {
        ["--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"]
    }
}

/// A file only one side has, as the worktree side would lack it from the index: added or removed.
fn worktree_only(old: &str, new: &str, file: &ChangedFile) -> bool {
    if old == WORKTREE { file.status == ChangeStatus::D } else { new == WORKTREE && file.status == ChangeStatus::A }
}

impl GitRepo {
    /// Raw `git diff` for one file. Untracked files diff against /dev/null; pass `untracked` when
    /// the caller already knows, else an added file is probed.
    pub async fn patch(
        &self,
        old: &str,
        new: &str,
        file: &ChangedFile,
        context: u32,
        untracked: Option<bool>,
    ) -> Result<String, GitError> {
        if old == WORKTREE && new == WORKTREE {
            return Ok(String::new());
        }
        let unified = format!("-U{context}");
        let reverse = old == WORKTREE;
        let untracked = match untracked {
            _ if !worktree_only(old, new, file) => false,
            Some(known) => known,
            None => !self.is_tracked(&file.path).await?,
        };
        if untracked {
            let mut args = vec!["diff", "--no-index"];
            if reverse {
                args.push("-R");
            }
            args.extend(patch_args(old));
            args.extend([unified.as_str(), "--", "/dev/null", file.path.as_str()]);
            let out = self.text_with(&args, ExecOptions { ok_codes: &[0, 1], ..Default::default() }).await?;
            // Normalize the a/ side so parsers see a conventional added-file header.
            let header = if reverse { &DELETED_HEADER } else { &ADDED_HEADER };
            return Ok(header
                .replace(&out, |m: &Captures| format!("diff --git {q}a/{rest} {q}b/{rest}", q = &m[1], rest = &m[2]))
                .into_owned());
        }
        let mut args = vec!["diff", "-M"];
        args.extend(patch_args(old));
        args.push(&unified);
        args.extend(diff_range(old, new));
        args.push("--");
        args.extend(file.old_path.as_deref());
        args.push(&file.path);
        self.text(&args).await
    }

    /// Patches for all changed files. Tracked files in one call; untracked appended.
    pub async fn patch_all(
        &self,
        old: &str,
        new: &str,
        files: &[ChangedFile],
        context: u32,
    ) -> Result<String, GitError> {
        if old == WORKTREE && new == WORKTREE {
            return Ok(String::new());
        }
        let unified = format!("-U{context}");
        let mut args = vec!["diff", "-M"];
        args.extend(patch_args(old));
        args.push(&unified);
        args.extend(diff_range(old, new));
        let untracked = async {
            let added: Vec<&ChangedFile> = files.iter().filter(|f| worktree_only(old, new, f) && !f.binary).collect();
            if added.is_empty() {
                return Ok(Vec::new());
            }
            // The whole index rather than the added paths as arguments: a large diff would exceed argv.
            let known: HashSet<String> = self.ls_files().await?.into_iter().collect();
            Ok::<_, GitError>(added.into_iter().filter(|f| !known.contains(&f.path)).cloned().collect::<Vec<_>>())
        };
        let (tracked, untracked) = tokio::join!(self.text(&args), untracked);
        let extras = map_limit(untracked?, READ_CONCURRENCY, |f: ChangedFile| async move {
            self.patch(old, new, &f, context, Some(true)).await
        })
        .await;
        let mut out = tracked?;
        for extra in extras {
            out += &extra?;
        }
        Ok(out)
    }

    /// Patches for `files` only: tracked ones in one call, worktree additions each on their own
    /// (`patch` probes whether they are untracked). The caller bounds the batch, so the paths ride argv.
    pub async fn patch_many(
        &self,
        old: &str,
        new: &str,
        files: &[ChangedFile],
        context: u32,
    ) -> Result<String, GitError> {
        if old == WORKTREE && new == WORKTREE {
            return Ok(String::new());
        }
        let (single, batched): (Vec<&ChangedFile>, Vec<&ChangedFile>) =
            files.iter().partition(|f| worktree_only(old, new, f));
        let unified = format!("-U{context}");
        let tracked = async {
            if batched.is_empty() {
                return Ok(String::new());
            }
            let mut args = vec!["diff", "-M"];
            args.extend(patch_args(old));
            args.push(&unified);
            args.extend(diff_range(old, new));
            args.push("--");
            for f in &batched {
                args.extend(f.old_path.as_deref());
                args.push(&f.path);
            }
            self.text(&args).await
        };
        let (tracked, extras) = tokio::join!(
            tracked,
            map_limit(single.into_iter().cloned().collect::<Vec<_>>(), READ_CONCURRENCY, |f: ChangedFile| async move {
                self.patch(old, new, &f, context, None).await
            })
        );
        let mut out = tracked?;
        for extra in extras {
            out += &extra?;
        }
        Ok(out)
    }

    async fn is_tracked(&self, path: &str) -> Result<bool, GitError> {
        let opts = ExecOptions { ok_codes: &[0, 1], ..Default::default() };
        Ok(!self.exec(&["ls-files", "-z", "--error-unmatch", "--", path], opts).await?.is_empty())
    }
}
