//! A review that ends at the worktree, exported onto HEAD: which threads carry over, and where they land.
use crate::common;

use common::TestRepo;
use diffle::github::worktree::onto_head;
use diffle::protocol::{CommentAnchor, CommentThread, Side};
use serde_json::json;

fn lines(n: usize, edit: impl Fn(usize) -> Option<&'static str>) -> String {
    (1..=n).map(|i| format!("{}\n", edit(i).map_or_else(|| format!("line {i}"), str::to_owned))).collect()
}

fn thread(id: &str, anchor: CommentAnchor) -> CommentThread {
    CommentThread {
        anchor,
        id: id.into(),
        messages: Vec::new(),
        resolved: false,
        resolved_at: None,
        stale: false,
        stale_from_line: None,
    }
}

fn line(id: &str, path: &str, side: Side, at: i64, quoted: &str) -> CommentThread {
    let anchor = CommentAnchor::Line { path: path.into(), side, start_line: at, end_line: at, quoted: quoted.into() };
    thread(id, anchor)
}

fn file(id: &str, path: &str) -> CommentThread {
    thread(id, CommentAnchor::File { path: path.into() })
}

#[tokio::test]
async fn carries_threads_on_committed_lines_onto_head_and_holds_back_those_on_uncommitted_changes() {
    let t = TestRepo::new();
    t.write("a.txt", lines(20, |_| None));
    t.write("untouched.txt", "same\n");
    t.commit("base");
    let base = t.git(&["rev-parse", "HEAD"]).trim().to_owned();
    t.write("a.txt", lines(20, |i| (i == 5).then_some("committed")));
    t.write("c.txt", "pushed\n");
    t.commit("change");
    let head = t.git(&["rev-parse", "HEAD"]).trim().to_owned();
    // Two lines on top shift every committed line down; line 19 changes in the worktree alone.
    let worktree = lines(20, |i| match i {
        5 => Some("committed"),
        19 => Some("uncommitted"),
        _ => None,
    });
    t.write("a.txt", format!("new 1\nnew 2\n{worktree}"));
    t.write("untouched.txt", "edited\n");
    t.write("d.txt", "untracked\n");
    let repo = t.open().await;

    let threads = vec![
        line("committed", "a.txt", Side::New, 7, "committed"),
        line("removed", "a.txt", Side::Old, 5, "line 5"),
        line("uncommitted", "a.txt", Side::New, 21, "uncommitted"),
        line("added-on-top", "a.txt", Side::New, 1, "new 1"),
        file("pushed-file", "c.txt"),
        file("untracked-file", "d.txt"),
        line("edited-file", "untouched.txt", Side::New, 1, "edited"),
    ];
    let (carried, unplaced) = onto_head(&repo, &base, &head, threads).await.unwrap();
    let placed: Vec<_> = carried.iter().filter(|t| !unplaced.contains_key(&t.id)).map(|t| (&t.id, &t.anchor)).collect();
    let mut held: Vec<_> = unplaced.iter().collect();
    held.sort();
    insta::assert_json_snapshot!(json!({ "placed": placed, "held": held }));
}
