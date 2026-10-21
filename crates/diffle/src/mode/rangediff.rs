//! Comparing two ranges: one's head replayed onto the other's base, and their commits paired.
use crate::error::{Error, Result};
use crate::git::GitRepo;
use crate::protocol::{MAX_RANGE_COMMITS, PairStatus, RangeCommit, RangeEnds, RangePair, range_label};

/// `older`'s head as it would be on `newer`'s base: the tree to show `newer`'s head against, so only
/// what the series itself changed in between shows, and the paths the replay could not merge.
/// The same base needs no replay: the older head's tree is what was reviewed.
pub async fn replay_range(repo: &GitRepo, older: &RangeEnds, newer: &RangeEnds) -> Result<(String, Vec<String>)> {
    if older.old_sha == newer.old_sha {
        return Ok((repo.tree(&older.new_sha).await?, Vec::new()));
    }
    Ok(repo.replay(&older.old_sha, &newer.old_sha, &older.new_sha).await?)
}

/// Pairs the two ranges' commits as `git range-diff` does and tells a pair whose patch is the same
/// (a reworded commit) from an amended one by patch id. range-diff compares every commit with
/// every other, so a range past MAX_RANGE_COMMITS is refused rather than left running.
pub async fn pair_ranges(repo: &GitRepo, older: &RangeEnds, newer: &RangeEnds) -> Result<Vec<RangePair>> {
    let old_range = format!("{}..{}", older.old_sha, older.new_sha);
    let new_range = format!("{}..{}", newer.old_sha, newer.new_sha);
    let (old_commits, new_commits) = tokio::try_join!(
        repo.range_commits(&old_range, MAX_RANGE_COMMITS),
        repo.range_commits(&new_range, MAX_RANGE_COMMITS)
    )?;
    for (side, commits) in [(older, &old_commits), (newer, &new_commits)] {
        if commits.total > MAX_RANGE_COMMITS as i64 {
            return Err(Error::revspec(format!(
                "{} spans {} commits; a range-diff takes at most {MAX_RANGE_COMMITS}",
                range_label(&side.old_sha, &side.new_sha),
                commits.total
            )));
        }
    }
    let rows = repo.range_diff(&old_range, &new_range).await?;
    // range-diff abbreviates; a commit beyond the listed window is looked up on its own.
    let find = |list: &[RangeCommit], abbrev: Option<String>| {
        let listed = abbrev.as_ref().and_then(|a| list.iter().find(|c| c.sha.starts_with(a.as_str())).cloned());
        async move {
            match (listed, abbrev) {
                (Some(commit), _) => Ok(Some(commit)),
                (None, Some(abbrev)) => {
                    Ok::<_, Error>(repo.range_commits(&format!("{abbrev}^!"), 1).await?.list.into_iter().next())
                }
                (None, None) => Ok(None),
            }
        }
    };
    let paired = futures::future::try_join_all(rows.into_iter().map(|row| {
        let (old, new) = (find(&old_commits.list, row.old), find(&new_commits.list, row.new));
        async move { Ok::<_, Error>((old.await?, new.await?, row.marker)) }
    }))
    .await?;
    let changed: Vec<String> = paired
        .iter()
        .filter_map(|(old, new, marker)| match (old, new) {
            (Some(old), Some(new)) if *marker == '!' => Some([old.sha.clone(), new.sha.clone()]),
            _ => None,
        })
        .flatten()
        .collect();
    let ids = repo.patch_ids(&changed).await?;
    Ok(paired
        .into_iter()
        .map(|(old, new, marker)| {
            let status = match marker {
                '=' => PairStatus::Identical,
                '<' => PairStatus::Dropped,
                '>' => PairStatus::Added,
                _ => match (&old, &new) {
                    (Some(o), Some(n)) if ids.get(&o.sha).is_some_and(|id| ids.get(&n.sha) == Some(id)) => {
                        PairStatus::Message
                    }
                    _ => PairStatus::Changed,
                },
            };
            RangePair { old, new, status }
        })
        .collect())
}
