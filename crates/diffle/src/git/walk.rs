//! Walking history: the commits of a range in git's order, and a commit's neighbours on HEAD's line.
use gix::ObjectId;
use gix::bstr::ByteSlice;
use gix::revision::plumbing::Spec;
use gix::revision::walk::Sorting;
use gix::traverse::commit::simple::CommitTimeOrder;

use super::GitRepo;
use crate::error::Result;
use crate::protocol::RangeCommit;

pub struct RangeList {
    pub list: Vec<RangeCommit>,
    pub total: i64,
}

impl GitRepo {
    /// The commits a revision range such as `a..b` or `c^!` selects, oldest first: the newest `limit`, and the total.
    pub async fn range_commits(&self, range: &str, limit: usize) -> Result<RangeList> {
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
    pub async fn commit_neighbours(&self, sha: &str) -> Result<(Option<String>, Option<String>)> {
        let sha = sha.to_owned();
        self.gix("walking HEAD's first parents", move |repo| {
            let Ok(target) = repo.rev_parse_single(sha.as_str()).map(gix::Id::detach) else {
                return Ok((None, None));
            };
            let Ok(target_commit) = repo.find_object(target)?.peel_to_commit() else {
                return Ok((None, None));
            };
            let parent = target_commit.parent_ids().next().map(|p| p.to_string());
            let Ok(head) = repo.head_id() else {
                return Ok((parent, None));
            };
            // HEAD's first-parent line down to where `sha`'s history begins, as `rev-list
            // --first-parent sha..HEAD` walks it: the child is the commit there whose first parent is `sha`.
            let line = repo.rev_walk([head.detach()]).first_parent_only().with_hidden([target_commit.id]).all()?;
            for info in line {
                let info = info?;
                if info.parent_ids.first() == Some(&target_commit.id) {
                    return Ok((parent, Some(info.id.to_string())));
                }
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

/// The commits reachable from `tips` but not from `hidden`, newest first by committer date.
fn date_order(repo: &gix::Repository, tips: &[ObjectId], hidden: Vec<ObjectId>) -> anyhow::Result<Vec<ObjectId>> {
    let walk = repo
        .rev_walk(tips.iter().copied())
        .with_hidden(hidden)
        .sorting(Sorting::ByCommitTime(CommitTimeOrder::NewestFirst))
        .all()?;
    walk.map(|info| Ok(info?.id)).collect()
}
