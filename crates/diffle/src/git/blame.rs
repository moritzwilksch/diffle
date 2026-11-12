//! Who last changed each line of a file, through gix-blame.
use std::collections::HashSet;
use std::io::Read;
use std::num::NonZeroU64;

use gix::blame::{BlameEntry, BlameRanges, Start};
use gix::bstr::{BStr, ByteSlice};
use gix::filter::plumbing::pipeline::convert::ToGitOutcome;

use super::GitRepo;
use crate::error::Result;
use crate::protocol::{BlameCommit, BlameHunk};

/// Hunks in line order and the commits they name, each once.
#[derive(Clone)]
pub struct Blame {
    pub hunks: Vec<BlameHunk>,
    pub commits: Vec<BlameCommit>,
}

impl Blame {
    /// The 1-based inclusive `first..=last` lines that exist, and only the commits they name.
    pub fn lines(&self, first: u64, last: u64) -> Blame {
        let mut hunks = Vec::new();
        for h in &self.hunks {
            let (start, end) = (h.start.get().max(first), (h.start.get() + h.lines.get() - 1).min(last));
            if let (Some(s), Some(n)) = (NonZeroU64::new(start), NonZeroU64::new((end + 1).saturating_sub(start))) {
                hunks.push(BlameHunk { start: s, lines: n, commit: h.commit.clone() });
            }
        }
        let named: HashSet<&str> = hunks.iter().filter_map(|h| h.commit.as_deref()).collect();
        let commits = self.commits.iter().filter(|c| named.contains(c.sha.as_str())).cloned().collect();
        Blame { hunks, commits }
    }
}

/// Where a blame starts: a revision, or worktree contents laid over HEAD.
pub enum BlameStart {
    Commit(String),
    Worktree(Vec<u8>),
}

impl GitRepo {
    /// Blames all of `path` from `start`, following renames. None when the revision names no commit
    /// or holds no file at `path`. Worktree contents are blamed as git would store them; lines HEAD
    /// does not hold name no commit.
    pub async fn blame(&self, start: BlameStart, path: &str) -> Result<Option<Blame>> {
        let path = path.to_owned();
        self.gix("blame", move |repo| {
            let start = match start {
                BlameStart::Commit(rev) => {
                    let Ok(id) = repo.rev_parse_single(rev.as_str()) else { return Ok(None) };
                    // An interdiff's old side is a replayed tree: no history to walk.
                    let Ok(commit) = id.object()?.try_into_commit() else { return Ok(None) };
                    let entry = commit.tree()?.lookup_entry_by_path(&path)?;
                    if !entry.is_some_and(|e| e.mode().is_blob_or_symlink()) {
                        return Ok(None);
                    }
                    Start::Commit(commit.id)
                }
                BlameStart::Worktree(contents) => {
                    let contents = to_git(repo, &path, contents)?;
                    let Some(head) = repo.head()?.id() else {
                        return Ok(Some(uncommitted(&contents)));
                    };
                    Start::Contents { first_suspect: head.detach(), contents: contents.into() }
                }
            };
            let options = gix::blame::Options {
                diff_algorithm: repo.diff_algorithm()?,
                ranges: BlameRanges::WholeFile,
                since: None,
                rewrites: Some(gix::diff::Rewrites::default()),
                debug_track_path: false,
            };
            let mut resources = repo.diff_resource_cache_for_tree_diff()?;
            let graph = repo.commit_graph_if_enabled()?;
            let file: &BStr = path.as_str().into();
            let outcome = gix::blame::file(&repo.objects, start, graph, &mut resources, file, options)?;
            Ok(Some(collect(repo, &outcome.entries)?))
        })
        .await
    }
}

/// `contents` after the filters `git add` applies (line endings, `ident`, drivers), so lines
/// match the blobs they are compared with.
fn to_git(repo: &gix::Repository, path: &str, contents: Vec<u8>) -> anyhow::Result<Vec<u8>> {
    let (mut pipeline, index) = repo.filter_pipeline(None)?;
    let converted = match pipeline.convert_to_git(contents.as_slice(), std::path::Path::new(path), &index)? {
        ToGitOutcome::Unchanged(_) => None,
        ToGitOutcome::Process(mut src) => {
            let mut buf = Vec::new();
            src.read_to_end(&mut buf)?;
            Some(buf)
        }
        ToGitOutcome::Buffer(buf) => Some(buf.to_vec()),
    };
    Ok(converted.unwrap_or(contents))
}

/// Every line as uncommitted: the worktree of an unborn branch.
fn uncommitted(contents: &[u8]) -> Blame {
    let lines = NonZeroU64::new(contents.lines().count() as u64);
    let hunks = lines.map(|lines| BlameHunk { start: NonZeroU64::MIN, lines, commit: None }).into_iter().collect();
    Blame { hunks, commits: Vec::new() }
}

fn collect(repo: &gix::Repository, entries: &[BlameEntry]) -> anyhow::Result<Blame> {
    let mut seen = HashSet::new();
    let mut commits = Vec::new();
    let mut hunks = Vec::with_capacity(entries.len());
    for entry in entries {
        let id = entry.commit_id;
        let commit = (!id.is_null()).then(|| id.to_string());
        if commit.is_some() && seen.insert(id) {
            commits.push(commit_of(repo, id)?);
        }
        let start = NonZeroU64::new(u64::from(entry.start_in_blamed_file) + 1).expect("one-based");
        hunks.push(BlameHunk { start, lines: NonZeroU64::from(entry.len), commit });
    }
    Ok(Blame { hunks, commits })
}

fn commit_of(repo: &gix::Repository, id: gix::ObjectId) -> anyhow::Result<BlameCommit> {
    let commit = repo.find_commit(id)?;
    let author = commit.author()?;
    let summary = commit.message()?.summary().to_str_lossy().into_owned();
    Ok(BlameCommit {
        sha: id.to_string(),
        short: commit.id().shorten_or_id().to_string(),
        author: author.name.to_str_lossy().into_owned(),
        time: author.time()?.seconds,
        summary,
    })
}
