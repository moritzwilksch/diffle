//! Walking history: the commits of a range in git's order, and a commit's neighbours on HEAD's line.
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};

use gix::ObjectId;
use gix::bstr::ByteSlice;
use gix::revision::plumbing::Spec;
use gix::revision::walk::Sorting;
use gix::traverse::commit::simple::CommitTimeOrder;

use super::GitRepo;
use crate::error::GitError;
use crate::protocol::RangeCommit;

pub struct RangeList {
    pub list: Vec<RangeCommit>,
    pub total: i64,
}

impl GitRepo {
    /// The commits a revision range such as `a..b` or `c^!` selects, oldest first: the newest `limit`, and the total.
    pub async fn range_commits(&self, range: &str, limit: usize) -> Result<RangeList, GitError> {
        let range = range.to_owned();
        self.gix("listing commits", move |repo| {
            let order = commits_in(repo, &range)?;
            let total = order.len() as i64;
            let list = order
                .into_iter()
                .take(limit)
                .rev()
                .map(|id| {
                    let commit = repo.find_commit(id)?;
                    let author = commit.author()?.trim();
                    Ok(RangeCommit {
                        sha: id.to_string(),
                        short: commit.id().shorten_or_id().to_string(),
                        author: author.name.to_str_lossy().into_owned(),
                        email: author.email.to_str_lossy().into_owned(),
                        date: author.seconds() * 1000,
                        message: commit.message_raw_sloppy().to_str_lossy().trim_end().to_owned(),
                    })
                })
                .collect::<anyhow::Result<_>>()?;
            Ok(RangeList { list, total })
        })
        .await
    }

    /// `sha`'s first parent, and the commit toward HEAD whose first parent it is. The child is none
    /// at HEAD, on an unborn branch, or when `sha` is off HEAD's first-parent line.
    pub async fn commit_neighbours(&self, sha: &str) -> Result<(Option<String>, Option<String>), GitError> {
        let sha = sha.to_owned();
        self.gix("walking HEAD's first parents", move |repo| {
            let Ok(target) = repo.rev_parse_single(sha.as_str()).map(gix::Id::detach) else {
                return Ok((None, None));
            };
            let first_parent = |id: ObjectId| -> anyhow::Result<Option<ObjectId>> {
                Ok(repo.find_commit(id)?.parent_ids().next().map(gix::Id::detach))
            };
            let parent = repo.find_object(target)?.peel_to_commit().ok().and_then(|c| c.parent_ids().next());
            let parent = parent.map(|p| p.to_string());
            let Ok(head) = repo.head_id() else {
                return Ok((parent, None));
            };
            let (mut at, mut child) = (Some(head.detach()), None);
            while let Some(id) = at {
                if id == target {
                    return Ok((parent, child.map(|c: ObjectId| c.to_string())));
                }
                child = Some(id);
                at = first_parent(id)?;
            }
            Ok((parent, None))
        })
        .await
    }
}

/// The commits a range such as `a..b`, `c^!` or `d` selects, newest first as `git log` lists them.
pub(super) fn commits_in(repo: &gix::Repository, range: &str) -> anyhow::Result<Vec<ObjectId>> {
    let commit = |id: ObjectId| -> anyhow::Result<ObjectId> { Ok(repo.find_object(id)?.peel_to_commit()?.id) };
    let (tips, hidden) = match repo.rev_parse(range)?.detach() {
        Spec::Include(id) => (vec![commit(id)?], Vec::new()),
        Spec::Range { from, to } => (vec![commit(to)?], vec![commit(from)?]),
        Spec::ExcludeParents(id) => {
            let tip = repo.find_commit(commit(id)?)?;
            (vec![tip.id], tip.parent_ids().map(gix::Id::detach).collect())
        }
        _ => anyhow::bail!("unsupported range {range}"),
    };
    date_order(repo, &tips, hidden)
}

/// The commits reachable from `tips` but not from `hidden`, newest first as `git log` lists them:
/// by committer date, ties in the order they were reached, a commit only once.
fn date_order(repo: &gix::Repository, tips: &[ObjectId], hidden: Vec<ObjectId>) -> anyhow::Result<Vec<ObjectId>> {
    let walk = repo
        .rev_walk(tips.iter().copied())
        .with_hidden(hidden)
        .sorting(Sorting::ByCommitTime(CommitTimeOrder::NewestFirst))
        .all()?;
    let mut selected = HashMap::new();
    for info in walk {
        let info = info?;
        selected.insert(info.id, (info.commit_time(), info.parent_ids.to_vec()));
    }
    // gix's queue breaks date ties arbitrarily; git's keeps them first-come, first-served.
    let mut queue = BinaryHeap::new();
    let mut seen = HashSet::new();
    let mut reached = 0u64;
    let mut push = |queue: &mut BinaryHeap<_>, id: ObjectId| {
        if let Some((time, _)) = selected.get(&id)
            && seen.insert(id)
        {
            queue.push((*time, Reverse(reached), id));
            reached += 1;
        }
    };
    for &tip in tips {
        push(&mut queue, tip);
    }
    let mut order = Vec::with_capacity(selected.len());
    while let Some((_, _, id)) = queue.pop() {
        order.push(id);
        for parent in selected[&id].1.clone() {
            push(&mut queue, parent);
        }
    }
    Ok(order)
}
