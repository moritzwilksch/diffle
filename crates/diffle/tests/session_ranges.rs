//! Iterations of a range and range-diffs, as the session enters, reloads and leaves them.
mod common;

use std::sync::Arc;

use common::{TestRepo, revspec, session};
use diffle::error::Error;
use diffle::protocol::{ComparisonBase, FollowRefs, Live, ModeRequest, PairStatus, Side, comparison_label};
use diffle::snapshotter::Snapshotter;

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|a| (*a).to_owned()).collect()
}

fn json<T: serde::Serialize>(value: &T) -> serde_json::Value {
    serde_json::to_value(value).unwrap()
}

/// The patch's changed lines, without its headers.
async fn edits(snapshotter: &Arc<Snapshotter>, path: &str) -> Vec<String> {
    let patch = snapshotter.patch(path).await.unwrap().unwrap();
    patch
        .lines()
        .filter(|l| {
            l.len() > 1 && (l.starts_with('+') || l.starts_with('-')) && !l.starts_with("+++") && !l.starts_with("---")
        })
        .map(str::to_owned)
        .collect()
}

fn pins(t: &TestRepo) -> Vec<String> {
    let mut out: Vec<String> = t
        .git(&["for-each-ref", "--format=%(objectname)", "refs/diffle/iterations/"])
        .lines()
        .map(str::to_owned)
        .collect();
    out.sort();
    out
}

fn sorted(mut list: Vec<String>) -> Vec<String> {
    list.sort();
    list
}

#[tokio::test]
async fn records_an_iteration_per_loaded_range_state_and_compares_two_across_a_rebase() {
    let t = TestRepo::new();
    t.write("a.txt", "a\n");
    t.write("b.txt", "b\n");
    t.commit("base");
    t.git(&["checkout", "-q", "-b", "feat"]);
    t.write("a.txt", "a\nfeature\n");
    t.git(&["commit", "-q", "-am", "feature"]);
    let repo = Arc::new(t.open().await);
    let (s, _) = session(&repo, false, 3, FollowRefs::Off);
    let first = s.start(s.resolve(revspec(&["main...feat"])).await.unwrap()).await.unwrap();
    assert_eq!(first.iterations.len(), 1);
    let it = &first.iterations[0];
    assert_eq!((it.n, it.old_sha.as_str(), it.new_sha.as_str()), (1, first.old_sha.as_str(), first.new_sha.as_str()));
    // The pins keep both ends alive whatever happens to the branches.
    assert_eq!(pins(&t), sorted(vec![first.old_sha.clone(), first.new_sha.clone()]));
    // Reloading the same state records nothing.
    assert_eq!(s.reload().await.unwrap().iterations.len(), 1);

    // Upstream moves on, the branch is rebased onto it and amended.
    t.git(&["checkout", "-q", "main"]);
    t.write("b.txt", "b\nupstream\n");
    t.git(&["commit", "-q", "-am", "upstream"]);
    t.git(&["checkout", "-q", "feat"]);
    t.git(&["rebase", "-q", "main"]);
    t.write("a.txt", "a\nfeature\namended\n");
    t.git(&["commit", "-q", "--amend", "--no-edit", "-a"]);
    let second = s.reload().await.unwrap();
    assert_eq!(second.iterations.iter().map(|it| it.n).collect::<Vec<_>>(), [1, 2]);
    assert_eq!(
        (second.iterations[1].old_sha.as_str(), second.iterations[1].new_sha.as_str()),
        (second.old_sha.as_str(), second.new_sha.as_str())
    );
    assert_eq!(second.changed.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["a.txt"]);

    // The interdiff shows the amend alone: b.txt's upstream change is on both sides after the replay.
    let to = std::num::NonZeroU64::new(2).unwrap();
    let from = std::num::NonZeroU64::new(1).unwrap();
    let inter = s.switch_mode(ModeRequest::Interdiff { from, to }).await.unwrap();
    let m = &inter.mode;
    assert_eq!((m.new.as_str(), m.base, m.live), (second.new_sha.as_str(), ComparisonBase::Direct, Live::Refs));
    assert_eq!(m.comment_key, format!("{}:interdiff:1-2", first.mode.comment_key));
    assert_eq!(m.within.as_ref().unwrap().comment_key, first.mode.comment_key);
    let interdiff = m.interdiff.as_ref().unwrap();
    assert_eq!((interdiff.from.iteration, interdiff.to.iteration), (Some(1), Some(2)));
    assert_eq!(
        (interdiff.from.new_sha.as_str(), interdiff.to.new_sha.as_str()),
        (first.new_sha.as_str(), second.new_sha.as_str())
    );
    assert!(interdiff.conflicts.is_empty());
    assert_ne!(m.old, first.new_sha);
    let snapshotter = s.snapshotter().unwrap();
    assert_eq!(edits(&snapshotter, "a.txt").await, ["+amended"]);
    let b = s.read_side(&inter, "b.txt", Side::Old).await.unwrap().unwrap();
    assert_eq!(b, b"b\nupstream\n");
    assert_eq!(inter.commits.list.iter().map(|c| c.message.as_str()).collect::<Vec<_>>(), ["feature"]);
    assert_eq!(inter.iterations.len(), 2);
    assert_eq!(comparison_label(m), "main...feat #1→#2");
    assert!(matches!(s.anchor_source().err(), Some(Error::Revspec(_))));

    // The range-diff pairs the rebased commit with its amended self; its pair shows the amend alone, too.
    let pairs = &interdiff.pairs;
    assert_eq!(pairs.len(), 1);
    assert_eq!((pairs[0].status, pairs[0].old.as_ref().unwrap().message.as_str()), (PairStatus::Changed, "feature"));
    let short = pairs[0].new.as_ref().unwrap().short.clone();
    let pair = s.switch_mode(ModeRequest::Pair { commit: Some(short) }).await.unwrap();
    let spec = pair.mode.pair.as_ref().unwrap();
    assert_eq!((spec.old.as_deref(), spec.new.as_str()), (Some(first.new_sha.as_str()), second.new_sha.as_str()));
    assert_eq!(edits(&s.snapshotter().unwrap(), "a.txt").await, ["+amended"]);
    assert_eq!(comparison_label(&pair.mode), format!("main...feat #1→#2 @ {}", &second.new_sha[..7]));
    assert_eq!(json(&s.switch_mode(ModeRequest::Pair { commit: None }).await.unwrap().mode), json(&inter.mode));
    assert!(matches!(s.switch_mode(ModeRequest::Pair { commit: Some("f".repeat(40)) }).await, Err(Error::Revspec(_))));

    // A reload from the interdiff returns to the range, where the moved refs would be picked up.
    assert_eq!(json(&s.reload().await.unwrap().mode), json(&first.mode));
    let three = std::num::NonZeroU64::new(3).unwrap();
    assert!(matches!(s.switch_mode(ModeRequest::Interdiff { from: to, to: from }).await, Err(Error::Revspec(_))));
    assert!(matches!(s.switch_mode(ModeRequest::Interdiff { from, to: three }).await, Err(Error::Revspec(_))));

    // One iteration can go, but not the latest. Forgetting the one an interdiff compares from returns to the range.
    s.switch_mode(ModeRequest::Interdiff { from, to }).await.unwrap();
    assert!(matches!(s.delete_iteration(2).await, Err(Error::Revspec(_))));
    assert!(matches!(s.delete_iteration(9).await, Err(Error::Revspec(_))));
    let dropped = s.delete_iteration(1).await.unwrap();
    assert_eq!(json(&dropped.mode), json(&first.mode));
    assert_eq!(dropped.iterations.iter().map(|it| it.n).collect::<Vec<_>>(), [2]);
    assert_eq!(pins(&t), sorted(vec![second.old_sha.clone(), second.new_sha.clone()]));

    // Forgetting all of them records the current state as #1 again.
    let cleared = s.clear_iterations().await.unwrap();
    assert_eq!(json(&cleared.mode), json(&first.mode));
    assert_eq!(
        cleared.iterations.iter().map(|it| (it.n, it.new_sha.clone())).collect::<Vec<_>>(),
        [(1, second.new_sha.clone())]
    );
    assert_eq!(pins(&t), sorted(vec![second.old_sha.clone(), second.new_sha.clone()]));
    s.close().await;
}

#[tokio::test]
async fn compares_two_named_ranges_like_git_range_diff_and_resolves_them_again_on_reload() {
    let t = TestRepo::new();
    t.write("a.txt", "a\n");
    t.write("b.txt", "b\n");
    t.commit("base");
    let base = t.git(&["rev-parse", "HEAD"]);
    t.git(&["checkout", "-q", "-b", "feat"]);
    t.write("a.txt", "a\nfeature\n");
    t.git(&["commit", "-q", "-am", "feature"]);
    let v1 = t.git(&["rev-parse", "feat"]);
    // Upstream moves on; the branch is rebased onto it, amended and extended.
    t.git(&["checkout", "-q", "main"]);
    t.write("b.txt", "b\nupstream\n");
    t.git(&["commit", "-q", "-am", "upstream"]);
    let main = t.git(&["rev-parse", "main"]);
    t.git(&["checkout", "-q", "feat"]);
    t.git(&["rebase", "-q", "main"]);
    t.write("a.txt", "a\nfeature\namended\n");
    t.git(&["commit", "-q", "--amend", "--no-edit", "-a"]);
    t.write("c.txt", "c\n");
    t.commit("extra");
    let v2 = t.git(&["rev-parse", "feat"]);

    let repo = Arc::new(t.open().await);
    let (s, _) = session(&repo, false, 3, FollowRefs::Off);
    let named = ModeRequest::RangeDiff { args: args(&[&format!("{base}..{v1}"), "main..feat"]) };
    let snap = s.start(s.resolve(named.clone()).await.unwrap()).await.unwrap();
    let range = serde_json::json!({ "old": "main", "new": "feat", "base": "direct", "live": "refs", "commentKey": "range:refs/heads/main..refs/heads/feat" });
    assert_eq!((snap.mode.new.as_str(), snap.mode.live), (v2.as_str(), Live::Refs));
    assert_eq!(snap.mode.comment_key, format!("range-diff:{base}..{v1}:{main}..{v2}"));
    assert_eq!(json(&snap.mode.within), range);
    let inter = snap.mode.interdiff.clone().unwrap();
    assert_eq!(
        json(&inter.from),
        serde_json::json!({ "old": base, "new": v1, "oldSha": base, "newSha": v1, "iteration": null })
    );
    assert_eq!(
        json(&inter.to),
        serde_json::json!({ "old": "main", "new": "feat", "oldSha": main, "newSha": v2, "iteration": null })
    );
    assert_eq!(snap.changed.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["a.txt", "c.txt"]);
    assert_eq!(edits(&s.snapshotter().unwrap(), "a.txt").await, ["+amended"]);
    assert_eq!(s.read_side(&snap, "b.txt", Side::Old).await.unwrap().unwrap(), b"b\nupstream\n");
    let rows: Vec<_> = inter
        .pairs
        .iter()
        .map(|p| (p.status, p.old.as_ref().map(|c| c.message.clone()), p.new.as_ref().map(|c| c.message.clone())))
        .collect();
    assert_eq!(
        rows,
        [
            (PairStatus::Changed, Some("feature".into()), Some("feature".into())),
            (PairStatus::Added, None, Some("extra".into()))
        ]
    );
    // The newer range is where the reviewer continues: its commits are listed and its state recorded.
    assert_eq!(snap.commits.list.iter().map(|c| c.message.as_str()).collect::<Vec<_>>(), ["feature", "extra"]);
    assert_eq!(
        snap.iterations.iter().map(|it| (it.n, it.old_sha.clone(), it.new_sha.clone())).collect::<Vec<_>>(),
        [(1, main.clone(), v2.clone())]
    );
    assert_eq!(comparison_label(&snap.mode), format!("{}..{} → main..feat", &base[..7], &v1[..7]));
    assert_eq!(s.anchor_source().err().unwrap().to_string(), "comments are off in a range-diff");

    // A pair shows the amend alone, and the whole range-diff is where it returns to.
    let short = inter.pairs[0].new.as_ref().unwrap().short.clone();
    let pair = s.switch_mode(ModeRequest::Pair { commit: Some(short) }).await.unwrap();
    assert_eq!(json(&pair.mode.within), range);
    assert_eq!(pair.mode.pair.as_ref().unwrap().new, t.git(&["rev-parse", "feat^"]));
    assert_eq!(
        comparison_label(&pair.mode),
        format!("{} @ {}", comparison_label(&snap.mode), t.git(&["rev-parse", "--short=7", "feat^"]))
    );
    assert_eq!(json(&s.switch_mode(ModeRequest::Pair { commit: None }).await.unwrap().mode), json(&snap.mode));
    // Focusing the newer range leads back to it as well.
    assert_eq!(json(&s.switch_mode(ModeRequest::Focus { commit: None }).await.unwrap().mode), range);

    // The branch moves on: a reload resolves both ranges again, so the new commit joins the pairs.
    s.switch_mode(named.clone()).await.unwrap();
    t.write("d.txt", "d\n");
    t.commit("more");
    let v3 = t.git(&["rev-parse", "feat"]);
    let reloaded = s.reload().await.unwrap();
    let inter = reloaded.mode.interdiff.clone().unwrap();
    assert_eq!(
        (inter.from.new_sha.as_str(), inter.to.old_sha.as_str(), inter.to.new_sha.as_str()),
        (v1.as_str(), main.as_str(), v3.as_str())
    );
    let added: Vec<_> = inter.pairs.iter().map(|p| p.new.as_ref().map(|c| c.message.clone())).collect();
    assert_eq!(added, [Some("feature".into()), Some("extra".into()), Some("more".into())]);
    assert_eq!(reloaded.iterations.iter().map(|it| it.n).collect::<Vec<_>>(), [1, 2]);
    // Forgetting the newer range's iterations keeps the range-diff on show.
    assert_eq!(s.clear_iterations().await.unwrap().mode.interdiff.clone().unwrap().to.new_sha, v3);

    // Equivalent forms, and the errors a typo earns.
    let three = s.resolve(ModeRequest::RangeDiff { args: args(&[&base, &v1, "feat"]) }).await.unwrap();
    let to = three.mode.interdiff.unwrap().to;
    assert_eq!(
        (to.old.as_str(), to.new.as_str(), to.old_sha.as_str(), to.new_sha.as_str()),
        (base.as_str(), "feat", base.as_str(), v3.as_str())
    );
    for bad in [&["main..worktree", "main..feat"][..], &["main..nope", "main..feat"], &["main..feat"]] {
        let err = s.resolve(ModeRequest::RangeDiff { args: args(bad) }).await.unwrap_err();
        assert!(matches!(err, Error::Revspec(_)), "{bad:?}: {err}");
    }

    // A reload from a pair resolves both ranges again too, and returns to the whole range-diff.
    let shown = s.switch_mode(named).await.unwrap();
    let last = shown.mode.interdiff.clone().unwrap().pairs.last().unwrap().new.clone().unwrap().short;
    s.switch_mode(ModeRequest::Pair { commit: Some(last) }).await.unwrap();
    t.write("e.txt", "e\n");
    t.commit("last");
    let v4 = t.git(&["rev-parse", "feat"]);
    let from_pair = s.reload().await.unwrap();
    assert!(from_pair.mode.pair.is_none());
    assert_eq!(from_pair.new_sha, v4);
    let messages: Vec<_> = from_pair
        .mode
        .interdiff
        .clone()
        .unwrap()
        .pairs
        .iter()
        .filter_map(|p| p.new.as_ref().map(|c| c.message.clone()))
        .collect();
    assert_eq!(messages, ["feature", "extra", "more", "last"]);
    assert!(from_pair.changed.iter().any(|f| f.path == "e.txt"));
    assert!(s.moved().unwrap().is_none());
    s.close().await;
}
