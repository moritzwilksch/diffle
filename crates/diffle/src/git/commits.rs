//! Revisions, commit metadata, and the plumbing range-diffs are built from.
use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;

use super::GitRepo;
use super::exec::ExecOptions;
use crate::error::{GitError, Result};
use crate::protocol::{CommitInfo, LastCommitsPreview, RangeCommit};

/// `git range-diff` pairs two commits while the diff between their patches costs less than this
/// percentage of a patch's size. Git's default of 60 leaves a reworded three-line commit unpaired,
/// since the message change alone outweighs it; at 100 the message may change as much as the patch.
const CREATION_FACTOR: &str = "--creation-factor=100";

/// Numbers are right-aligned, so rows of a range with ten or more commits start with spaces.
static RANGE_DIFF_ROW: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*(?:\d+:\s+([0-9a-f]+)|-:\s+-+)\s+([=!<>])\s+(?:\d+:\s+([0-9a-f]+)|-:\s+-+)\s").unwrap()
});

/// One row of `git range-diff -s`: abbreviated hashes, none on the side a commit has no counterpart.
pub struct RangeDiffRow {
    pub old: Option<String>,
    pub new: Option<String>,
    /// `=` identical, `!` changed, `<` only in the first range, `>` only in the second.
    pub marker: char,
}

pub struct RangeList {
    pub list: Vec<RangeCommit>,
    pub total: i64,
}

impl GitRepo {
    /// Commit sha for a user-supplied revision. `--end-of-options` keeps an option-shaped name a name.
    pub async fn resolve(&self, rev: &str) -> Result<String, GitError> {
        let commit = format!("{rev}^{{commit}}");
        Ok(self.text(&["rev-parse", "--verify", "--quiet", "--end-of-options", &commit]).await?.trim().to_owned())
    }

    /// `resolve`, with none for a revision that names nothing.
    pub async fn try_resolve(&self, rev: &str) -> Result<Option<String>, GitError> {
        match self.resolve(rev).await {
            Ok(sha) => Ok(Some(sha)),
            Err(e) if e.is_missing() => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// The tree a commit points at.
    pub async fn tree(&self, rev: &str) -> Result<String, GitError> {
        let tree = format!("{rev}^{{tree}}");
        Ok(self.text(&["rev-parse", "--verify", "--quiet", "--end-of-options", &tree]).await?.trim().to_owned())
    }

    /// Commit messages for two ancestor offsets, pinned to one HEAD.
    pub async fn last_commits_preview(&self, old_offset: u64, new_offset: u64) -> Result<LastCommitsPreview> {
        let Some(head) = self.commit_info("HEAD").await? else {
            return Ok(LastCommitsPreview { old: None, new: None });
        };
        let at = |offset: u64| {
            let head = head.clone();
            async move {
                if offset == 0 { Ok(Some(head)) } else { self.commit_info(&format!("{}~{offset}", head.sha)).await }
            }
        };
        let (old, new) = tokio::try_join!(at(old_offset), at(new_offset))?;
        Ok(LastCommitsPreview { old, new })
    }

    /// A commit's hash, abbreviation and full message; none when `rev` names no commit.
    pub async fn commit_info(&self, rev: &str) -> Result<Option<CommitInfo>, GitError> {
        let Some(sha) = self.try_resolve(rev).await? else {
            return Ok(None);
        };
        let out = self.text(&["log", "-1", "--no-show-signature", "--format=%h%x00%B", &sha, "--"]).await?;
        let (short, message) = out.split_once('\0').unwrap_or((&out, ""));
        Ok(Some(CommitInfo { short: short.to_owned(), message: message.trim_end().to_owned(), sha }))
    }

    /// `sha`'s first parent, and the commit toward HEAD whose first parent it is. The child is none
    /// at HEAD, on an unborn branch, or when `sha` is off HEAD's first-parent line.
    pub async fn commit_neighbours(&self, sha: &str) -> Result<(Option<String>, Option<String>), GitError> {
        let (range, parent) = (format!("{sha}..HEAD"), format!("{sha}^"));
        let descendants = ["rev-list", "--first-parent", "--ancestry-path", "--parents", &range, "--"];
        let (parent, list) = tokio::join!(self.try_resolve(&parent), self.text(&descendants));
        let list = list.unwrap_or_default();
        // Newest first, so the oldest descendant comes last; it is the child only if it sits on sha directly.
        let mut last = list.trim().lines().last().unwrap_or_default().split(' ');
        let child = match (last.next(), last.next()) {
            (Some(child), Some(first_parent)) if !child.is_empty() && first_parent == sha => Some(child.to_owned()),
            _ => None,
        };
        Ok((parent?, child))
    }

    /// The commits a revision range such as `a..b` or `c^!` selects, oldest first: the newest `limit`, and the total.
    pub async fn range_commits(&self, range: &str, limit: usize) -> Result<RangeList, GitError> {
        let max = format!("--max-count={limit}");
        let format = "--format=%H%x00%h%x00%an%x00%ae%x00%at%x00%B";
        let count = ["rev-list", "--count", "--end-of-options", range, "--"];
        let log = ["log", "-z", "--no-show-signature", "--reverse", &max, format, "--end-of-options", range, "--"];
        let (count, log) = tokio::try_join!(self.text(&count), self.text(&log))?;
        // Fields cannot contain NUL, and `-z` ends each record with one, so every commit is six fields.
        let fields: Vec<&str> = log.split('\0').collect();
        let list = fields
            .as_chunks::<6>()
            .0
            .iter()
            .map(|f| RangeCommit {
                sha: f[0].to_owned(),
                short: f[1].to_owned(),
                author: f[2].to_owned(),
                email: f[3].to_owned(),
                date: f[4].parse::<i64>().unwrap_or(0) * 1000,
                message: f[5].trim_end().to_owned(),
            })
            .collect();
        Ok(RangeList { list, total: count.trim().parse().unwrap_or(0) })
    }

    /// The empty tree under the repository's hash algorithm: the old side of an unborn branch.
    pub async fn empty_tree(&self) -> Result<String, GitError> {
        let opts = ExecOptions { input: Some(b""), ..Default::default() };
        Ok(self.text_with(&["hash-object", "-t", "tree", "--stdin"], opts).await?.trim().to_owned())
    }

    pub async fn merge_base(&self, a: &str, b: &str) -> Result<String, GitError> {
        Ok(self.text(&["merge-base", "--end-of-options", a, b]).await?.trim().to_owned())
    }

    /// Replays what `head` changed since `base` onto `onto`, in memory: the resulting tree, and the
    /// paths the merge could not settle, which the tree holds with conflict markers. Needs git 2.38.
    pub async fn replay(&self, base: &str, onto: &str, head: &str) -> Result<(String, Vec<String>), GitError> {
        let merge_base = format!("--merge-base={base}");
        let args = ["merge-tree", "--write-tree", "-z", "--name-only", &merge_base, "--end-of-options", onto, head];
        let out = self.text_with(&args, ExecOptions { ok_codes: &[1], ..Default::default() }).await?;
        // With -z, the tree, each conflicted path and the sections end in NUL.
        let mut parts = out.split('\0');
        let tree = parts.next().unwrap_or_default().to_owned();
        let conflicts = parts.take_while(|p| !p.is_empty()).map(str::to_owned).collect();
        Ok((tree, conflicts))
    }

    /// How `git range-diff` pairs the commits of two ranges, in its output order. Summary only, no
    /// patches. Ranges are given as hashes: range-diff learnt `--end-of-options` only in git 2.44.
    pub async fn range_diff(&self, old_range: &str, new_range: &str) -> Result<Vec<RangeDiffRow>, GitError> {
        let out = self.text(&["range-diff", "-s", "--no-color", CREATION_FACTOR, old_range, new_range]).await?;
        Ok(out
            .lines()
            .filter_map(|line| RANGE_DIFF_ROW.captures(line))
            .map(|m| RangeDiffRow {
                old: m.get(1).map(|s| s.as_str().to_owned()),
                new: m.get(3).map(|s| s.as_str().to_owned()),
                marker: m[2].chars().next().unwrap_or('!'),
            })
            .collect())
    }

    /// Each commit's stable patch id, so two commits with the same change under different messages compare equal.
    pub async fn patch_ids(&self, shas: &[String]) -> Result<HashMap<String, String>, GitError> {
        let mut ids = HashMap::new();
        if shas.is_empty() {
            return Ok(ids);
        }
        let mut args = vec!["log", "-p", "--no-walk", "--no-show-signature", "--format=%H", "--end-of-options"];
        args.extend(shas.iter().map(String::as_str));
        let patches = self.exec(&args, ExecOptions::default()).await?;
        let opts = ExecOptions { input: Some(&patches), ..Default::default() };
        for line in self.text_with(&["patch-id", "--stable"], opts).await?.lines() {
            if let Some((id, sha)) = line.split_once(' ') {
                ids.insert(sha.to_owned(), id.to_owned());
            }
        }
        Ok(ids)
    }

    /// Points refs at objects so they survive `gc` and a force-push, or with none deletes them.
    /// Refs must stay inside `refs/diffle/iterations/`: nothing the user owns moves.
    pub async fn pin(&self, refs: &[(String, Option<String>)]) -> Result<(), GitError> {
        let mut lines = String::new();
        for (name, sha) in refs {
            if !name.starts_with("refs/diffle/iterations/") {
                return Err(GitError::refused(format!("refusing to update {name}"), &["update-ref"]));
            }
            lines += &match sha {
                Some(sha) => format!("update {name} {sha}\n"),
                None => format!("delete {name}\n"),
            };
        }
        if !lines.is_empty() {
            let opts = ExecOptions { input: Some(lines.as_bytes()), ..Default::default() };
            self.exec(&["update-ref", "--stdin"], opts).await?;
        }
        Ok(())
    }
}
