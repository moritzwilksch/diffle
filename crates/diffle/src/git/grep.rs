//! Searching the new side as `git grep -I -z` does, in-process and bounded: files in path order,
//! lines in order, stopping once enough matches have been found.
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use gix::ObjectId;
use gix::bstr::{BString, ByteSlice};
use gix::index::entry::{Flags, Mode, Stage};
use regex::bytes::{Regex, RegexBuilder};

use super::diff::{NoDiff, is_binary};
use super::{GitRepo, WORKTREE};
use crate::error::GitError;

/// A search that runs this long is a runaway regex, not a slow repository.
const GREP_TIMEOUT: Duration = Duration::from_secs(10);
/// A match's line is cut to this many characters.
const MAX_TEXT: usize = 300;
/// Files are searched on up to this many threads.
const MAX_WORKERS: usize = 8;

#[derive(Default)]
pub struct GrepOptions<'a> {
    /// Whole words only (vim's `*`).
    pub word: bool,
    pub ignore_case: bool,
    /// An extended regex instead of a fixed string.
    pub regex: bool,
    /// Restricts files, each a literal path or directory; an empty list matches nothing.
    pub paths: Option<&'a [String]>,
    /// Restricts new-side lines, inclusive, before the limit applies; an empty map matches nothing.
    pub ranges: Option<&'a HashMap<String, Vec<(i64, i64)>>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrepMatch {
    pub path: String,
    pub line: i64,
    pub text: String,
}

pub struct GrepResult {
    pub matches: Vec<GrepMatch>,
    pub truncated: bool,
}

impl GitRepo {
    /// Search the new side, case-sensitive unless asked otherwise. Worktree searches cover tracked
    /// and untracked files. The search stops at `limit + 1` matches, so a common query in a large
    /// repository cannot flood the process; binary files and symlinks are skipped, as git skips them.
    pub async fn grep(
        &self,
        query: &str,
        rev: &str,
        limit: usize,
        opts: GrepOptions<'_>,
    ) -> Result<GrepResult, GitError> {
        // An explicit empty path list means "search nothing", not everything.
        if query.is_empty()
            || opts.paths.is_some_and(<[String]>::is_empty)
            || opts.ranges.is_some_and(HashMap::is_empty)
        {
            return Ok(GrepResult { matches: Vec::new(), truncated: false });
        }
        let pattern = if opts.regex { query.to_owned() } else { regex::escape(query) };
        let regex = RegexBuilder::new(&pattern)
            .case_insensitive(opts.ignore_case)
            .multi_line(true)
            .build()
            .map_err(|e| GitError::refused(format!("invalid search pattern: {e}"), &["grep"]))?;
        let untracked = if rev == WORKTREE { self.untracked().await? } else { Vec::new() };
        let (rev, root, word) = (rev.to_owned(), self.root.clone(), opts.word);
        let paths = opts.paths.map(<[String]>::to_vec);
        let ranges = opts.ranges.cloned();
        let deadline = Instant::now() + GREP_TIMEOUT;
        let matches = self
            .gix("grep", move |repo| {
                let selected = |path: &str| {
                    paths.as_ref().is_none_or(|paths| {
                        paths
                            .iter()
                            .any(|p| path == p || path.strip_prefix(p.as_str()).is_some_and(|r| r.starts_with('/')))
                    })
                };
                let files: Vec<_> = candidates(repo, &rev, untracked)?
                    .into_iter()
                    .filter(|(p, _)| selected(&p.to_str_lossy()))
                    .collect();
                let search = Search { regex: &regex, word, ranges: ranges.as_ref(), root: &root, limit };
                search.run(repo, &files, deadline)
            })
            .await?;
        let truncated = matches.len() > limit;
        Ok(GrepResult { matches: matches.into_iter().take(limit).collect(), truncated })
    }
}

struct Search<'a> {
    regex: &'a Regex,
    word: bool,
    ranges: Option<&'a HashMap<String, Vec<(i64, i64)>>>,
    root: &'a std::path::Path,
    limit: usize,
}

impl Search<'_> {
    /// Searches `files` on a pool of workers, each with its own repository handle, and gathers
    /// their matches in file order, stopping all of them once that order holds `limit + 1`.
    fn run(
        &self,
        repo: &gix::Repository,
        files: &[(BString, Option<ObjectId>)],
        deadline: Instant,
    ) -> anyhow::Result<Vec<GrepMatch>> {
        let workers =
            std::thread::available_parallelism().map_or(1, usize::from).clamp(1, MAX_WORKERS).min(files.len().max(1));
        let next = AtomicUsize::new(0);
        let stop = AtomicBool::new(false);
        let (tx, rx) = mpsc::channel::<(usize, anyhow::Result<Vec<GrepMatch>>)>();
        std::thread::scope(|scope| {
            for _ in 0..workers {
                let (repo, tx, next, stop) = (repo.clone(), tx.clone(), &next, &stop);
                scope.spawn(move || {
                    let mut no_diff = match NoDiff::new(&repo) {
                        Ok(no_diff) => no_diff,
                        Err(e) => return drop(tx.send((0, Err(e)))),
                    };
                    while !stop.load(Ordering::Relaxed) {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        let Some((path, blob)) = files.get(i) else { break };
                        let found = if Instant::now() > deadline {
                            Err(anyhow::anyhow!("timed out after {}ms", GREP_TIMEOUT.as_millis()))
                        } else {
                            self.file(&repo, &mut no_diff, path, *blob)
                        };
                        if tx.send((i, found)).is_err() {
                            break;
                        }
                    }
                });
            }
            drop(tx);
            let (mut pending, mut done, mut found) = (HashMap::new(), 0, Vec::new());
            while done < files.len() && found.len() <= self.limit {
                let Ok((i, result)) = rx.recv() else { break };
                pending.insert(i, result);
                while let Some(result) = pending.remove(&done) {
                    found.extend(result.inspect_err(|_| stop.store(true, Ordering::Relaxed))?);
                    done += 1;
                }
            }
            stop.store(true, Ordering::Relaxed);
            found.truncate(self.limit + 1);
            Ok(found)
        })
    }

    /// One file's matches, at most `limit + 1` of them.
    fn file(
        &self,
        repo: &gix::Repository,
        no_diff: &mut NoDiff<'_>,
        path: &BString,
        blob: Option<ObjectId>,
    ) -> anyhow::Result<Vec<GrepMatch>> {
        let mut found = Vec::new();
        let Some(content) = read(repo, self.root, path, blob) else { return Ok(found) };
        if is_binary(&content) || no_diff.get(path)? || !self.regex.is_match(&content) {
            return Ok(found);
        }
        let path = path.to_str_lossy().into_owned();
        let visible = self.ranges.map(|r| r.get(&path).cloned().unwrap_or_default());
        for (n, line) in content.lines_with_terminator().enumerate() {
            // Only the newline goes: a CR before it belongs to the line, as git prints it.
            let line = line.strip_suffix(b"\n").unwrap_or(line);
            let n = n as i64 + 1;
            if visible.as_ref().is_some_and(|v| !v.iter().any(|&(start, end)| n >= start && n <= end)) {
                continue;
            }
            if matches_line(self.regex, line, self.word) {
                let text = line.to_str_lossy().chars().take(MAX_TEXT).collect();
                found.push(GrepMatch { path: path.clone(), line: n, text });
                if found.len() > self.limit {
                    break;
                }
            }
        }
        Ok(found)
    }
}

/// The regular files to search, sorted, with a tree's blob ids: a tree's files, or the index's plus
/// the untracked ones, read from the worktree.
fn candidates(
    repo: &gix::Repository,
    rev: &str,
    untracked: Vec<String>,
) -> anyhow::Result<Vec<(BString, Option<ObjectId>)>> {
    let regular = |mode: Mode| mode == Mode::FILE || mode == Mode::FILE_EXECUTABLE;
    let mut files: Vec<(BString, Option<ObjectId>)> = if rev == WORKTREE {
        let index = repo.index_or_empty()?;
        let mut tracked: Vec<_> = index
            .entries()
            .iter()
            .filter(|e| regular(e.mode) && !e.flags.contains(Flags::SKIP_WORKTREE))
            .filter(|e| e.stage() == Stage::Unconflicted || e.stage() == Stage::Ours)
            .map(|e| (e.path(&index).to_owned(), None))
            .collect();
        tracked.extend(untracked.into_iter().filter(|p| !p.ends_with('/')).map(|p| (BString::from(p), None)));
        tracked
    } else {
        let tree = repo.rev_parse_single(rev)?.object()?.peel_to_tree()?.id;
        let index = repo.index_from_tree(&tree)?;
        index.entries().iter().filter(|e| regular(e.mode)).map(|e| (e.path(&index).to_owned(), Some(e.id))).collect()
    };
    files.sort();
    files.dedup_by(|a, b| a.0 == b.0);
    Ok(files)
}

/// A file's bytes as git grep reads them: the blob in a tree, the file itself in the worktree.
fn read(repo: &gix::Repository, root: &std::path::Path, path: &BString, blob: Option<ObjectId>) -> Option<Vec<u8>> {
    if let Some(id) = blob {
        return Some(repo.find_object(id).ok()?.detach().data);
    }
    let abs = root.join(gix::path::from_bstr(path.as_bstr()).ok()?);
    std::fs::symlink_metadata(&abs).ok().filter(std::fs::Metadata::is_file)?;
    std::fs::read(&abs).ok()
}

/// Whether `line` matches; with `word`, only where the match has no word character on either
/// side, retrying after each match that does, as git's `-w` does.
fn matches_line(regex: &Regex, line: &[u8], word: bool) -> bool {
    if !word {
        return regex.is_match(line);
    }
    let is_word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let mut start = 0;
    while start <= line.len() {
        let Some(m) = regex.find_at(line, start) else { return false };
        let before = m.start() == 0 || !is_word(line[m.start() - 1]);
        let after = m.end() == line.len() || !is_word(line[m.end()]);
        if before && after && !m.is_empty() {
            return true;
        }
        start = m.start() + 1;
    }
    false
}
