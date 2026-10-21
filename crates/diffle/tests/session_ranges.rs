//! Iterations of a range and range-diffs, as the session enters, reloads and leaves them.
mod common;

use std::sync::Arc;

use common::{TestRepo, revspec, session};
use diffle::error::Error;
use diffle::mode::resolve::range;
use diffle::protocol::{
    ComparisonBase, EnterRequest, FollowRefs, Live, PairStatus, RangeRef, RangeView, Review, Side, comparison_label,
    range_of, shown_iterations, with_view,
};
use diffle::snapshotter::Snapshotter;

fn nth(n: u64) -> RangeRef {
    RangeRef::Iteration { n: std::num::NonZeroU64::new(n).unwrap() }
}

fn interdiff(from: RangeRef, to: Option<RangeRef>, pair: Option<&str>) -> RangeView {
    RangeView::Interdiff { from, to, pair: pair.map(str::to_owned) }
}

/// The shown interdiff view with `pair` in place of its pair.
fn pair_of(review: &Review, pair: Option<&str>) -> RangeView {
    let Review::Range { view: RangeView::Interdiff { from, to, .. }, .. } = review else { panic!("an interdiff") };
    interdiff(from.clone(), to.clone(), pair)
}

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
    let inter = s.show(interdiff(nth(1), Some(nth(2)), None)).await.unwrap();
    assert_eq!(json(&inter.review), json(&with_view(&first.review, interdiff(nth(1), Some(nth(2)), None)).unwrap()));
    assert_eq!(
        (inter.new_sha.as_str(), inter.follows, inter.comment_key.as_str()),
        (second.new_sha.as_str(), Live::Refs, format!("{}:interdiff:1-2", first.comment_key).as_str())
    );
    assert_eq!(json(&range_of(&inter.review)), json(&first.review));
    assert_eq!(shown_iterations(&inter.review), Some((1, 2)));
    let resolved = inter.interdiff.as_ref().unwrap();
    assert_eq!(
        (resolved.from.new_sha.as_str(), resolved.to.new_sha.as_str()),
        (first.new_sha.as_str(), second.new_sha.as_str())
    );
    assert!(resolved.conflicts.is_empty());
    assert_ne!(inter.old_sha, first.new_sha);
    let snapshotter = s.snapshotter().unwrap();
    assert_eq!(edits(&snapshotter, "a.txt").await, ["+amended"]);
    let b = s.read_side(&inter, "b.txt", Side::Old).await.unwrap().unwrap();
    assert_eq!(b, b"b\nupstream\n");
    assert_eq!(inter.commits.list.iter().map(|c| c.message.as_str()).collect::<Vec<_>>(), ["feature"]);
    assert_eq!(inter.iterations.len(), 2);
    assert_eq!(comparison_label(&inter.review), "main...feat #1→#2");
    assert!(matches!(s.anchor_source().err(), Some(Error::Revspec(_))));
    assert_eq!(s.comments().unwrap().key(), inter.comment_key);

    // The range-diff pairs the rebased commit with its amended self; its pair shows the amend alone, too.
    let pairs = &resolved.pairs;
    assert_eq!(pairs.len(), 1);
    assert_eq!((pairs[0].status, pairs[0].old.as_ref().unwrap().message.as_str()), (PairStatus::Changed, "feature"));
    let short = pairs[0].new.as_ref().unwrap().short.clone();
    let pair = s.show(pair_of(&inter.review, Some(&short))).await.unwrap();
    assert_eq!(
        json(&pair.review),
        json(&with_view(&first.review, pair_of(&inter.review, Some(&second.new_sha))).unwrap())
    );
    let range_key = &first.comment_key;
    assert_eq!(pair.comment_key, format!("{range_key}:pair:{}-{}", first.new_sha, second.new_sha));
    assert_eq!(edits(&s.snapshotter().unwrap(), "a.txt").await, ["+amended"]);
    assert_eq!(comparison_label(&pair.review), format!("main...feat #1→#2 @ {}", &second.new_sha[..7]));
    assert_eq!(json(&s.show(pair_of(&inter.review, None)).await.unwrap().review), json(&inter.review));
    let bad = s.show(pair_of(&inter.review, Some(&"f".repeat(40)))).await;
    assert!(matches!(bad, Err(Error::Revspec(_))));

    // A reload from the interdiff returns to the range, where the moved refs would be picked up.
    assert_eq!(json(&s.reload().await.unwrap().review), json(&first.review));
    assert!(matches!(s.show(interdiff(nth(2), Some(nth(1)), None)).await, Err(Error::Revspec(_))));
    assert!(matches!(s.show(interdiff(nth(1), Some(nth(3)), None)).await, Err(Error::Revspec(_))));

    // One iteration can go, but not the latest. Forgetting the one an interdiff compares from returns to the range.
    s.show(interdiff(nth(1), Some(nth(2)), None)).await.unwrap();
    assert!(matches!(s.delete_iteration(2).await, Err(Error::Revspec(_))));
    assert!(matches!(s.delete_iteration(9).await, Err(Error::Revspec(_))));
    let dropped = s.delete_iteration(1).await.unwrap();
    assert_eq!(json(&dropped.review), json(&first.review));
    assert_eq!(dropped.iterations.iter().map(|it| it.n).collect::<Vec<_>>(), [2]);
    assert_eq!(pins(&t), sorted(vec![second.old_sha.clone(), second.new_sha.clone()]));

    // Forgetting all of them records the current state as #1 again.
    let cleared = s.clear_iterations().await.unwrap();
    assert_eq!(json(&cleared.review), json(&first.review));
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
    let named = EnterRequest::RangeDiff { args: args(&[&format!("{base}..{v1}"), "main..feat"]) };
    let snap = s.start(s.resolve(named.clone()).await.unwrap()).await.unwrap();
    let whole = range("main", "feat", ComparisonBase::Direct);
    let older = RangeRef::Named { old: base.clone(), new: v1.clone() };
    assert_eq!(json(&snap.review), json(&with_view(&whole, interdiff(older.clone(), None, None)).unwrap()));
    assert_eq!((snap.new_sha.as_str(), snap.follows), (v2.as_str(), Live::Refs));
    assert_eq!(snap.comment_key, format!("range-diff:{base}..{v1}:{main}..{v2}"));
    let inter = snap.interdiff.clone().unwrap();
    assert_eq!(json(&inter.from), serde_json::json!({ "oldSha": base, "newSha": v1 }));
    assert_eq!(json(&inter.to), serde_json::json!({ "oldSha": main, "newSha": v2 }));
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
    assert_eq!(comparison_label(&snap.review), format!("{}..{} → main..feat", &base[..7], &v1[..7]));
    assert_eq!(s.anchor_source().err().unwrap().to_string(), "comments are off in a range-diff");

    // A pair shows the amend alone, and the whole range-diff is where it returns to.
    let short = inter.pairs[0].new.as_ref().unwrap().short.clone();
    let pair = s.show(pair_of(&snap.review, Some(&short))).await.unwrap();
    assert_eq!(json(&range_of(&pair.review)), json(&whole));
    let amended = t.git(&["rev-parse", "feat^"]);
    assert_eq!(json(&pair.review), json(&with_view(&whole, interdiff(older.clone(), None, Some(&amended))).unwrap()));
    assert_eq!(
        comparison_label(&pair.review),
        format!("{} @ {}", comparison_label(&snap.review), t.git(&["rev-parse", "--short=7", "feat^"]))
    );
    assert_eq!(json(&s.show(pair_of(&snap.review, None)).await.unwrap().review), json(&snap.review));
    // Focusing the newer range leads back to it as well.
    assert_eq!(json(&s.show(RangeView::Whole).await.unwrap().review), json(&whole));

    // The branch moves on: a reload resolves both ranges again, so the new commit joins the pairs.
    s.enter(named.clone()).await.unwrap();
    t.write("d.txt", "d\n");
    t.commit("more");
    let v3 = t.git(&["rev-parse", "feat"]);
    let reloaded = s.reload().await.unwrap();
    let inter = reloaded.interdiff.clone().unwrap();
    assert_eq!(
        (inter.from.new_sha.as_str(), inter.to.old_sha.as_str(), inter.to.new_sha.as_str()),
        (v1.as_str(), main.as_str(), v3.as_str())
    );
    let added: Vec<_> = inter.pairs.iter().map(|p| p.new.as_ref().map(|c| c.message.clone())).collect();
    assert_eq!(added, [Some("feature".into()), Some("extra".into()), Some("more".into())]);
    assert_eq!(reloaded.iterations.iter().map(|it| it.n).collect::<Vec<_>>(), [1, 2]);
    // Forgetting the newer range's iterations keeps the range-diff on show.
    assert_eq!(s.clear_iterations().await.unwrap().interdiff.clone().unwrap().to.new_sha, v3);

    // Equivalent forms, and the errors a typo earns.
    let three = s.resolve(EnterRequest::RangeDiff { args: args(&[&base, &v1, "feat"]) }).await.unwrap();
    let from = RangeRef::Named { old: base.clone(), new: v1.clone() };
    let expected = with_view(&range(base.clone(), "feat", ComparisonBase::Direct), interdiff(from, None, None));
    assert_eq!(json(&three), json(&expected.unwrap()));
    for bad in [&["main..worktree", "main..feat"][..], &["main..nope", "main..feat"], &["main..feat"]] {
        let err = s.resolve(EnterRequest::RangeDiff { args: args(bad) }).await.unwrap_err();
        assert!(matches!(err, Error::Revspec(_)), "{bad:?}: {err}");
    }

    // A reload from a pair resolves both ranges again too, and returns to the whole range-diff.
    let shown = s.enter(named).await.unwrap();
    let last = shown.interdiff.clone().unwrap().pairs.last().unwrap().new.clone().unwrap().short;
    s.show(pair_of(&shown.review, Some(&last))).await.unwrap();
    t.write("e.txt", "e\n");
    t.commit("last");
    let v4 = t.git(&["rev-parse", "feat"]);
    let from_pair = s.reload().await.unwrap();
    assert_eq!(json(&from_pair.review), json(&snap.review));
    assert_eq!(from_pair.new_sha, v4);
    let messages: Vec<_> = from_pair
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
