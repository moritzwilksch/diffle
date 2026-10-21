mod common;

use common::TestRepo;

/// feat edits line 2; main appends, then conflicts with feat on line 2.
fn replay_repo() -> TestRepo {
    let t = TestRepo::new();
    t.write("f.txt", "a\nb\nc\n");
    t.commit("base");
    t.git(&["checkout", "-q", "-b", "feat"]);
    t.write("f.txt", "a\nB\nc\n");
    t.commit("feat");
    t.git(&["checkout", "-q", "main"]);
    t.write("f.txt", "a\nb\nc\nd\n");
    t.commit("main: append");
    t.write("f.txt", "a\nX\nc\nd\n");
    t.commit("main: conflict");
    t
}

#[tokio::test]
async fn replays_a_branch_onto_a_moved_base_and_names_the_files_it_could_not_merge() {
    let t = replay_repo();
    let repo = t.open().await;
    let base = t.git(&["rev-parse", "main~2"]);
    let (tree, conflicts) = repo.replay(&base, "main~1", "feat").await.unwrap();
    assert!(conflicts.is_empty());
    assert_eq!(repo.show(&tree, "f.txt").await.unwrap().unwrap(), b"a\nB\nc\nd\n");
    let (tree, conflicts) = repo.replay(&base, "main", "feat").await.unwrap();
    assert_eq!(conflicts, ["f.txt"]);
    assert!(String::from_utf8(repo.show(&tree, "f.txt").await.unwrap().unwrap()).unwrap().contains("<<<<<<<"));
    assert_eq!(repo.tree("feat").await.unwrap(), t.git(&["rev-parse", "feat^{tree}"]));
}

#[tokio::test]
async fn pairs_two_ranges_and_tells_reworded_commits_from_amended_ones_by_patch_id() {
    let t = replay_repo();
    let base = t.git(&["rev-parse", "main~2"]);
    // feat2: the same change as feat under a new message, plus a commit of its own.
    t.git(&["checkout", "-q", "-b", "feat2", &base]);
    t.write("f.txt", "a\nB\nc\n");
    t.git(&["commit", "-q", "-am", "feat, reworded"]);
    t.write("g.txt", "g\n");
    t.commit("extra");
    let repo = t.open().await;
    let [feat, reworded, extra] = ["feat", "feat2~1", "feat2"].map(|rev| t.git(&["rev-parse", rev]));
    let rows = repo.range_diff(&format!("{base}..feat"), &format!("{base}..feat2")).await.unwrap();
    assert_eq!(rows.iter().map(|r| r.marker).collect::<String>(), "!>");
    assert!(feat.starts_with(rows[0].old.as_deref().unwrap()));
    assert!(reworded.starts_with(rows[0].new.as_deref().unwrap()));
    assert!(rows[1].old.is_none() && extra.starts_with(rows[1].new.as_deref().unwrap()));
    let ids = repo.patch_ids(&[feat.clone(), reworded.clone(), extra.clone()]).await.unwrap();
    assert_eq!(ids[&feat], ids[&reworded]);
    assert_ne!(ids[&extra], ids[&feat]);
    assert!(repo.patch_ids(&[]).await.unwrap().is_empty());
}

#[tokio::test]
async fn reads_the_right_aligned_rows_of_a_range_with_ten_or_more_commits() {
    let t = replay_repo();
    let base = t.git(&["rev-parse", "main~2"]);
    t.git(&["checkout", "-q", "-b", "many", &base]);
    for i in 1..=10 {
        t.write(&format!("n{i}.txt"), format!("{i}\n"));
        t.commit(&format!("n{i}"));
    }
    let repo = t.open().await;
    let rows = repo.range_diff(&format!("{base}..many~1"), &format!("{base}..many")).await.unwrap();
    assert_eq!(rows.iter().map(|r| r.marker).collect::<String>(), "=========>");
    assert!(t.git(&["rev-parse", "many"]).starts_with(rows[9].new.as_deref().unwrap()));
}

#[tokio::test]
async fn pins_and_deletes_refs_under_refs_diffle_iterations_only() {
    let t = replay_repo();
    let repo = t.open().await;
    let sha = t.git(&["rev-parse", "feat"]);
    let name = "refs/diffle/iterations/x/1/new".to_owned();
    repo.pin(&[(name.clone(), Some(sha.clone()))]).await.unwrap();
    assert_eq!(t.git(&["rev-parse", &name]), sha);
    repo.pin(&[(name, None)]).await.unwrap();
    assert_eq!(t.git(&["for-each-ref", "refs/diffle/iterations/"]), "");
    for outside in ["refs/heads/main", "refs/diffle/other/1"] {
        let err = repo.pin(&[(outside.to_owned(), Some(sha.clone()))]).await.unwrap_err();
        assert!(err.to_string().starts_with("refusing to update"), "{err}");
    }
}

#[tokio::test]
async fn a_range_diff_review_replays_the_older_range_and_pairs_its_commits() {
    let t = replay_repo();
    let base = t.git(&["rev-parse", "main~2"]);
    t.git(&["checkout", "-q", "-b", "feat2", "main~1"]);
    t.write("f.txt", "a\nB\nc\nd\n");
    t.git(&["commit", "-q", "-am", "feat, rebased"]);
    let repo = std::sync::Arc::new(t.open().await);
    let req = diffle::protocol::EnterRequest::RangeDiff { args: vec![format!("{base}..feat"), "main~1..feat2".into()] };
    let (_, snap) = common::snapshot(&repo, req).await;
    let inter = snap.interdiff.clone().unwrap();
    let (feat, feat2) = (t.git(&["rev-parse", "feat"]), t.git(&["rev-parse", "feat2"]));
    let onto = t.git(&["rev-parse", "main~1"]);
    assert_eq!((snap.new_sha.as_str(), snap.follows), (feat2.as_str(), diffle::protocol::Live::Refs));
    assert_eq!(snap.comment_key, format!("range-diff:{base}..{feat}:{onto}..{feat2}"));
    // feat replayed onto main~1 is what feat2 holds: the rebase alone shows nothing.
    assert_eq!(repo.show(&snap.old_sha, "f.txt").await.unwrap().unwrap(), b"a\nB\nc\nd\n");
    assert!(inter.conflicts.is_empty());
    let pairs: Vec<_> = inter
        .pairs
        .iter()
        .map(|p| (p.old.as_ref().map(|c| c.sha.clone()), p.new.as_ref().map(|c| c.sha.clone()), p.status))
        .collect();
    assert_eq!(pairs, [(Some(feat), Some(feat2), diffle::protocol::PairStatus::Changed)]);
    let diffle::protocol::Review::Range { old, .. } = &snap.review else { panic!("a range") };
    assert_eq!(old, "main~1");
}
