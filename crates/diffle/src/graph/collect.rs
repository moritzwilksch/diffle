//! Gathers a snapshot's facts from a `SymbolSource`: which changed files can be graphed, which
//! changed symbols they hold, and who references them.
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::num::NonZeroU64;

use super::assemble::{GraphFile, SymbolKey, assemble};
use super::cache::Completeness;
use super::limits::{Deadline, Limits};
use super::outlines::{Outline, key_of, outline_all};
use super::settle::{Answer, Subject, ask, settle};
use super::source::SymbolSource;
use super::tally::{Found, Gathered, NOTE_INDEXING, Notes, Sites, Tally};
use crate::error::Result;
use crate::protocol::{
    ChangeStatus, ChangedFile, GraphResponse, LanguageId, LspPosition, LspSymbol, Snapshot, language_of,
};

/// How rust-analyzer's outline names an impl block: `impl Kind`, `impl<T> Kind<T>`.
const IMPL_KEYWORD: &str = "impl";

/// The graph of `snap`, and whether a later build could find more of it.
pub async fn build<S: SymbolSource>(
    source: &S,
    snap: &Snapshot,
    limits: &Limits,
) -> Result<(GraphResponse, Completeness)> {
    let Gathered { facts, completeness } = collect(source, snap, limits).await?;
    // Louvain over tens of thousands of files is CPU work that would hold a request worker.
    let graph = tokio::task::spawn_blocking(move || assemble(facts)).await.map_err(anyhow::Error::from)?;
    Ok((graph, completeness))
}

/// Every changed file of `snap` lands in `files` or `other`. Files are in path order: Louvain
/// visits them in `files` order, so a stable order keeps clusters stable.
pub async fn collect<S: SymbolSource>(source: &S, snap: &Snapshot, limits: &Limits) -> Result<Gathered> {
    let deadline = Deadline::new(limits.deadline);
    // Warming the servers is best effort: a slow start is the deadline's to cut.
    let _ = deadline.within(source.prepare()).await;
    let changed: BTreeMap<&str, &ChangedFile> = snap.changed.iter().map(|f| (f.path.as_str(), f)).collect();
    let mut tally = Tally::default();
    if let Some(why) = source.unavailable() {
        tally.other.extend(changed.keys().map(|p| (*p).to_owned()));
        tally.notes.add(why);
        // The servers may come up: nothing was asked, so asking again is cheap.
        tally.degraded = true;
        return Ok(tally.into_gathered(snap, Vec::new(), Found::default(), &deadline));
    }
    let (candidates, reasons) = candidates(source, &changed, &mut tally);
    let outlines = outline_all(source, &candidates, &witnesses(&changed), limits, &deadline, &mut tally).await?;
    // Reasons a file with a language was refused explain the graph only when nothing was graphed.
    if outlines.is_empty() && !reasons.is_empty() {
        tally.notes.merge(reasons);
        tally.degraded = true;
    }
    let declared: Vec<Subject> = outlines.iter().flat_map(|(path, o)| subjects_of(path, &o.changed)).collect();
    // An impl block still names the symbol a use sits in; only its type is asked what uses it.
    let changed_keys: BTreeSet<SymbolKey> = declared.iter().map(|s| s.key.clone()).collect();
    let mut subjects: Vec<Subject> = declared.into_iter().filter(|s| !is_impl_block(&s.key)).collect();
    let all_symbols = subjects.len();
    if all_symbols > limits.symbols {
        tally
            .notes
            .add(format!("Only {} of {all_symbols} changed symbols were checked for references", limits.symbols));
        subjects.truncate(limits.symbols);
    }
    let first = ask(source, &deadline, &subjects.iter().collect::<Vec<_>>()).await?;
    let settled = settle(source, &limits.patience, &deadline, &subjects, first).await?;
    if settled.indexing || outlines.values().any(|o| o.indexing) {
        tally.notes.add(NOTE_INDEXING.into());
        tally.degraded = true;
    }
    let sites = Sites {
        outlines: &outlines,
        changed: changed.keys().copied().collect(),
        tree: snap.tree.iter().map(String::as_str).collect(),
        changed_keys,
    };
    let mut found = Found::default();
    for (subject, answer) in subjects.iter().zip(&settled.answers) {
        match answer {
            Answer::Found(locations) => sites.absorb(&mut found, &subject.key, locations),
            Answer::Failed(why) => {
                tally.notes.add(format!("references unavailable: {why}"));
                tally.degraded = true;
            }
            Answer::Errored => tally.failed += 1,
            Answer::Inconclusive | Answer::Unfinished => {}
        }
    }
    let files = graph_files(&outlines);
    Ok(tally.into_gathered(snap, files, found, &deadline))
}

fn graph_files(outlines: &BTreeMap<String, Outline>) -> Vec<GraphFile> {
    let count = |o: &Outline| u32::try_from(o.changed.len()).unwrap_or(u32::MAX);
    outlines.iter().map(|(path, o)| GraphFile { path: path.clone(), symbols: count(o) }).collect()
}

/// The changed files a server could outline, and the reasons the others with a language cannot be.
/// Whether servers can serve a language is asked once per language, not per file.
fn candidates<'a, S: SymbolSource>(
    source: &S,
    changed: &BTreeMap<&'a str, &ChangedFile>,
    tally: &mut Tally,
) -> (Vec<&'a str>, Notes) {
    let mut by_language: HashMap<LanguageId, Option<String>> = HashMap::new();
    let (mut candidates, mut reasons) = (Vec::new(), Notes::default());
    for (&path, file) in changed {
        let Some(language) = graphable_language(file) else {
            tally.other.insert(path.to_owned());
            continue;
        };
        match by_language.entry(language).or_insert_with(|| source.blocker(path)) {
            Some(why) => {
                reasons.add(why.clone());
                tally.other.insert(path.to_owned());
            }
            None => candidates.push(path),
        }
    }
    (candidates, reasons)
}

/// Deleted source files: not graphed, but what they held may have moved into a graphed file.
fn witnesses<'a>(changed: &BTreeMap<&'a str, &ChangedFile>) -> Vec<&'a str> {
    let read = |file: &ChangedFile| {
        file.status == ChangeStatus::D && !file.binary && !file.generated && file.submodule != Some(true)
    };
    changed.iter().filter(|(path, file)| read(file) && language_of(path).is_some()).map(|(path, _)| *path).collect()
}

/// The language of a file a language server could outline at all: a text file that still exists.
fn graphable_language(file: &ChangedFile) -> Option<LanguageId> {
    let live = file.status != ChangeStatus::D && !file.binary && !file.generated && file.submodule != Some(true);
    live.then(|| language_of(&file.path)).flatten()
}

/// rust-analyzer lists `impl Kind` beside `Kind` and points both at the type's name, so asking both
/// reports one use twice. The impl's methods are separate symbols and stay asked.
fn is_impl_block(key: &SymbolKey) -> bool {
    let named_so = key.name.strip_prefix(IMPL_KEYWORD).is_some_and(|rest| rest.starts_with([' ', '<']));
    named_so && language_of(&key.path) == Some(LanguageId::Rust)
}

fn subjects_of(path: &str, changed: &[LspSymbol]) -> Vec<Subject> {
    changed.iter().filter_map(|s| subject(path, s)).collect()
}

/// A symbol the server placed at a line below 1 cannot be asked about; it makes no node.
fn subject(path: &str, symbol: &LspSymbol) -> Option<Subject> {
    let line = u64::try_from(symbol.line).ok().and_then(NonZeroU64::new)?;
    let at = LspPosition { col: symbol.col, line, path: path.parse().ok()? };
    Some(Subject { key: key_of(symbol), at })
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::{Value, json};

    use super::*;
    use crate::error::Error;
    use crate::graph::assemble::Facts;
    use crate::graph::cache::Completeness;
    use crate::graph::limits::MAX_SYMBOLS;
    use crate::graph::settle::Patience;
    use crate::graph::source::fake::{Fake, OutlineReply, Reply, external, loc, sym};

    const QUICK: Limits = Limits {
        symbols: MAX_SYMBOLS,
        patience: Patience { poll: Duration::from_millis(1), limit: Duration::from_millis(50) },
        deadline: Duration::from_secs(60),
    };

    fn change(path: &str, status: &str, binary: bool, generated: bool) -> Value {
        json!({ "path": path, "status": status, "additions": 0, "deletions": 0, "binary": binary,
            "blob": "", "oldBlob": "", "generated": generated })
    }

    fn snapshot(changed: &[Value], tree: &[&str]) -> Snapshot {
        serde_json::from_value(json!({
            "root": "/r", "version": 7, "oldSha": "a", "newSha": "worktree", "headSha": "", "context": 3,
            "review": { "kind": "range", "old": "HEAD", "new": "worktree", "base": "direct", "view": { "kind": "whole" } },
            "follows": "worktree", "commentKey": "working", "changed": changed, "tree": tree, "commit": null,
            "commits": { "list": [], "total": 0, "oldSha": "a", "newSha": "worktree" }, "iterations": [],
        }))
        .unwrap()
    }

    fn modified(paths: &[&str]) -> Vec<Value> {
        paths.iter().map(|p| change(p, "M", false, false)).collect()
    }

    /// `a.py` holds `alpha` (lines 1-3) and `b.py` holds `beta` (lines 1-3), both touched.
    fn pair() -> Fake {
        Fake::default().file("a.py", &[2], vec![sym("a.py", "alpha", 12, 1, 3)]).file(
            "b.py",
            &[2],
            vec![sym("b.py", "beta", 12, 1, 3)],
        )
    }

    fn edges(facts: &Facts) -> Vec<String> {
        facts.edges.iter().map(|e| format!("{} <- {}", e.used, e.by)).collect()
    }

    async fn facts_of(source: &Fake, changed: &[Value], tree: &[&str]) -> Facts {
        collect(source, &snapshot(changed, tree), &QUICK).await.unwrap().facts
    }

    #[tokio::test]
    async fn an_edge_carries_the_used_symbols_kind_and_the_call_site_lines_in_the_user() {
        let source = Fake::default()
            .file("a.py", &[2], vec![sym("a.py", "alpha", 5, 1, 3)])
            .file("b.py", &[2], vec![sym("b.py", "beta", 12, 1, 9)])
            .replies("a.py", 1, vec![Reply::Found(vec![loc("b.py", 7), loc("b.py", 2), loc("b.py", 7)])]);
        let facts = facts_of(&source, &modified(&["a.py", "b.py"]), &["a.py", "b.py"]).await;
        let found: Vec<(i64, i64, Vec<u32>)> =
            facts.edges.iter().map(|e| (e.used.kind, e.by.kind, e.lines.clone())).collect();
        assert_eq!(found, [(5, 12, vec![2, 7])]);
    }

    #[tokio::test]
    async fn a_reference_inside_another_changed_symbol_is_an_edge_and_the_declaration_is_not() {
        let source =
            pair().replies("a.py", 1, vec![Reply::Found(vec![loc("a.py", 1), loc("b.py", 2), loc("b.py", 2)])]);
        let facts = facts_of(&source, &modified(&["a.py", "b.py"]), &["a.py", "b.py"]).await;
        assert_eq!(edges(&facts), ["a.py#1:alpha <- b.py#1:beta"]);
        assert!(facts.callers.is_empty());
    }

    #[tokio::test]
    async fn files_are_listed_by_path_with_their_changed_symbol_counts() {
        let source = pair();
        let facts = facts_of(&source, &modified(&["b.py", "a.py"]), &["a.py", "b.py"]).await;
        let files: Vec<_> = facts.files.iter().map(|f| (f.path.as_str(), f.symbols)).collect();
        assert_eq!((files, facts.version, facts.note), (vec![("a.py", 1), ("b.py", 1)], 7, None));
    }

    #[tokio::test]
    async fn an_unchanged_file_is_a_caller_counted_per_symbol_with_its_first_five_lines_in_order() {
        let hits = [9, 3, 7, 5, 1, 11, 13].map(|l| loc("use.py", l)).to_vec();
        let source = pair().replies("a.py", 1, vec![Reply::Found(hits)]);
        let facts = facts_of(&source, &modified(&["a.py", "b.py"]), &["a.py", "b.py", "use.py"]).await;
        let site = facts.callers.values().next().unwrap().get("use.py").unwrap();
        assert_eq!((site.count, site.lines.clone()), (7, vec![1, 3, 5, 7, 9]));
        assert_eq!(facts.callers.keys().next().unwrap().name, "alpha");
    }

    #[tokio::test]
    async fn external_hits_same_file_hits_and_paths_outside_the_snapshot_link_nothing() {
        let hits = vec![external("use.py", 4), loc("a.py", 3), loc("ghost.py", 2)];
        let source = pair().replies("a.py", 1, vec![Reply::Found(hits)]);
        let facts = facts_of(&source, &modified(&["a.py", "b.py"]), &["a.py", "b.py", "use.py"]).await;
        assert!(facts.edges.is_empty() && facts.callers.is_empty(), "{facts:?}");
    }

    #[tokio::test]
    async fn a_hit_in_a_changed_file_outside_its_changed_symbols_is_neither_edge_nor_context() {
        // `b.py` also holds an untouched `helper` (lines 5-6); a hit there is a changed file's own code.
        let source = Fake::default()
            .file("a.py", &[2], vec![sym("a.py", "alpha", 12, 1, 3)])
            .file("b.py", &[2], vec![sym("b.py", "beta", 12, 1, 3), sym("b.py", "helper", 12, 5, 6)])
            .replies("a.py", 1, vec![Reply::Found(vec![loc("b.py", 5), loc("b.py", 20)])]);
        let facts = facts_of(&source, &modified(&["a.py", "b.py"]), &["a.py", "b.py"]).await;
        assert!(facts.edges.is_empty() && facts.callers.is_empty(), "{facts:?}");
    }

    #[tokio::test]
    async fn deleted_binary_generated_and_languageless_files_are_other_and_never_queried() {
        let changed = [
            change("a.py", "M", false, false),
            change("gone.py", "D", false, false),
            change("img.py", "M", true, false),
            change("gen.py", "M", false, true),
            change("notes.md", "M", false, false),
        ];
        let source = Fake::default().file("a.py", &[2], vec![sym("a.py", "alpha", 12, 1, 3)]);
        let facts = facts_of(&source, &changed, &["a.py"]).await;
        let files: Vec<_> = facts.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(files, ["a.py"]);
        assert_eq!(facts.other, ["gen.py", "gone.py", "img.py", "notes.md"]);
        assert_eq!(source.asked.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_language_its_server_cannot_serve_is_other_asked_once_and_the_rest_are_still_graphed() {
        let mut source = pair().file("c.ts", &[2], vec![sym("c.ts", "gamma", 12, 1, 3)]);
        // The blocker is a language's: the first python file stands for every python file.
        source.blocked.insert("a.py".into(), "No language server for python on PATH".into());
        let facts = facts_of(&source, &modified(&["a.py", "b.py", "c.ts"]), &["a.py", "b.py", "c.ts"]).await;
        let files: Vec<_> = facts.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!((files, facts.other, facts.note), (vec!["c.ts"], vec!["a.py".to_owned(), "b.py".into()], None));
        assert_eq!(source.blocker_calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn when_no_file_can_be_graphed_every_one_is_other_and_the_note_says_why() {
        let mut source = pair();
        source.blocked.insert("a.py".into(), "No language server for python on PATH".into());
        source.blocked.insert("b.py".into(), "No language server for python on PATH".into());
        let facts = facts_of(&source, &modified(&["a.py", "b.py", "notes.md"]), &["a.py"]).await;
        assert_eq!(
            (facts.files.len(), facts.other, facts.note.as_deref()),
            (
                0,
                vec!["a.py".to_owned(), "b.py".into(), "notes.md".into()],
                Some("No language server for python on PATH")
            )
        );
    }

    #[tokio::test]
    async fn a_run_without_usable_servers_puts_everything_in_other_with_the_reason() {
        let mut source = pair();
        source.off = Some("Language servers are off for this run (--no-lsp)".into());
        let facts = facts_of(&source, &modified(&["a.py", "b.py", "notes.md"]), &["a.py"]).await;
        assert_eq!(
            (facts.files.len(), facts.other, facts.note.as_deref()),
            (
                0,
                vec!["a.py".to_owned(), "b.py".into(), "notes.md".into()],
                Some("Language servers are off for this run (--no-lsp)")
            )
        );
        assert!(source.asked.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_outline_the_server_refuses_sends_that_file_to_other_without_failing_the_build() {
        let mut source = pair();
        source.outlines.insert("b.py".into(), Err("pyrefly is unavailable".into()));
        let facts = facts_of(&source, &modified(&["a.py", "b.py"]), &["a.py", "b.py"]).await;
        assert_eq!((facts.files.len(), facts.other), (1, vec!["b.py".to_owned()]));
    }

    #[tokio::test]
    async fn symbols_past_the_cap_are_not_asked_and_the_note_counts_them() {
        let source = pair();
        let limits = Limits { symbols: 1, ..QUICK };
        let facts =
            collect(&source, &snapshot(&modified(&["a.py", "b.py"]), &["a.py", "b.py"]), &limits).await.unwrap().facts;
        assert_eq!(source.asked.lock().unwrap().len(), 1);
        assert_eq!(facts.note.as_deref(), Some("Only 1 of 2 changed symbols were checked for references"));
    }

    #[tokio::test]
    async fn an_answer_still_inconclusive_after_the_retry_adds_the_indexing_note() {
        let source = pair().replies("a.py", 1, vec![Reply::Inconclusive, Reply::Inconclusive]);
        let facts = facts_of(&source, &modified(&["a.py", "b.py"]), &["a.py", "b.py"]).await;
        assert_eq!(facts.note.as_deref(), Some("language servers were still indexing: links may be missing"));
        assert_eq!(source.asked_at("a.py", 1), 2);
    }

    #[tokio::test]
    async fn an_answer_that_turns_up_after_the_retry_counts_and_leaves_no_note() {
        let source = pair().replies("a.py", 1, vec![Reply::Inconclusive, Reply::Found(vec![loc("b.py", 2)])]);
        let facts = facts_of(&source, &modified(&["a.py", "b.py"]), &["a.py", "b.py"]).await;
        assert_eq!((edges(&facts), facts.note), (vec!["a.py#1:alpha <- b.py#1:beta".to_owned()], None));
    }

    #[tokio::test]
    async fn a_references_query_no_server_can_answer_is_noted_and_the_graph_goes_on() {
        let source = pair().replies("a.py", 1, vec![Reply::Unavailable("fake offers no references")]);
        let facts = facts_of(&source, &modified(&["a.py", "b.py"]), &["a.py", "b.py"]).await;
        assert_eq!(facts.note.as_deref(), Some("references unavailable: fake offers no references"));
        assert_eq!(facts.files.len(), 2);
    }

    fn timeout() -> Error {
        Error::Other(std::sync::Arc::new(anyhow::anyhow!("request timed out")))
    }

    #[tokio::test]
    async fn a_references_timeout_skips_that_symbol_and_says_so_once_in_aggregate() {
        let source = pair().replies("a.py", 1, vec![Reply::Fail(timeout())]).replies(
            "b.py",
            1,
            vec![Reply::Fail(Error::Invalid("no document".into()))],
        );
        let facts = facts_of(&source, &modified(&["a.py", "b.py"]), &["a.py", "b.py"]).await;
        assert_eq!(facts.note.as_deref(), Some("2 language-server queries failed"));
        assert_eq!(facts.files.len(), 2);
    }

    #[tokio::test]
    async fn an_outline_that_times_out_sends_that_file_to_other_and_the_build_goes_on() {
        let source = pair().outline_replies("b.py", vec![OutlineReply::Fail(timeout())]);
        let facts = facts_of(&source, &modified(&["a.py", "b.py"]), &["a.py", "b.py"]).await;
        assert_eq!(
            (facts.files.len(), facts.other, facts.note.as_deref()),
            (1, vec!["b.py".to_owned()], Some("1 language-server queries failed"))
        );
    }

    #[tokio::test]
    async fn a_git_failure_still_fails_the_build() {
        let git = Error::Git(crate::error::GitError::refused("boom", &["diff"]));
        let source = pair().replies("a.py", 1, vec![Reply::Fail(git)]);
        let result = collect(&source, &snapshot(&modified(&["a.py", "b.py"]), &["a.py", "b.py"]), &QUICK).await;
        assert!(matches!(result, Err(Error::Git(_))));
    }

    #[tokio::test]
    async fn an_empty_outline_given_while_the_server_was_busy_is_asked_again_after_it_settles() {
        let source = pair().outline_replies("b.py", vec![OutlineReply::Busy]);
        let source = source.replies("a.py", 1, vec![Reply::Found(vec![loc("b.py", 2)])]);
        let facts = facts_of(&source, &modified(&["a.py", "b.py"]), &["a.py", "b.py"]).await;
        assert_eq!(source.outlined_count("b.py"), 2);
        assert_eq!((edges(&facts), facts.note), (vec!["a.py#1:alpha <- b.py#1:beta".to_owned()], None));
    }

    #[tokio::test]
    async fn an_outline_still_empty_after_the_retry_adds_the_indexing_note() {
        let source = pair().outline_replies("b.py", vec![OutlineReply::Busy, OutlineReply::Busy]);
        let facts = facts_of(&source, &modified(&["a.py", "b.py"]), &["a.py", "b.py"]).await;
        assert_eq!(source.outlined_count("b.py"), 2);
        assert_eq!(facts.note.as_deref(), Some("language servers were still indexing: links may be missing"));
    }

    async fn gathered_of(source: &Fake, changed: &[Value], tree: &[&str], limits: &Limits) -> Gathered {
        collect(source, &snapshot(changed, tree), limits).await.unwrap()
    }

    async fn completeness(source: &Fake) -> Completeness {
        gathered_of(source, &modified(&["a.py", "b.py"]), &["a.py", "b.py"], &QUICK).await.completeness
    }

    #[tokio::test]
    async fn a_build_with_every_answer_in_is_complete() {
        let source = pair().replies("a.py", 1, vec![Reply::Found(vec![loc("b.py", 2)])]);
        assert_eq!(completeness(&source).await, Completeness::Complete);
    }

    #[tokio::test]
    async fn answers_a_later_build_could_improve_make_it_degraded() {
        let indexing = pair().replies("a.py", 1, vec![Reply::Inconclusive, Reply::Inconclusive]);
        let outline_busy = pair().outline_replies("b.py", vec![OutlineReply::Busy, OutlineReply::Busy]);
        let failed = pair().replies("a.py", 1, vec![Reply::Fail(timeout())]);
        let unavailable = pair().replies("a.py", 1, vec![Reply::Unavailable("starting")]);
        let mut off = pair();
        off.off = Some("Language servers are off for this run (--no-lsp)".into());
        for (name, source) in [
            ("indexing", indexing),
            ("busy outline", outline_busy),
            ("failed", failed),
            ("unavailable", unavailable),
            ("off", off),
        ] {
            assert_eq!(completeness(&source).await, Completeness::Degraded, "{name}");
        }
    }

    #[tokio::test]
    async fn the_deadline_stops_the_asking_assembles_what_was_gathered_and_says_so() {
        let mut source = pair().replies("a.py", 1, vec![Reply::Found(vec![loc("b.py", 2)])]);
        source.delay = Duration::from_secs(30);
        let limits = Limits { deadline: Duration::from_millis(50), ..QUICK };
        let started = std::time::Instant::now();
        let got = gathered_of(&source, &modified(&["a.py", "b.py"]), &["a.py", "b.py"], &limits).await;
        assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
        assert_eq!(got.completeness, Completeness::Degraded);
        assert_eq!(got.facts.note.as_deref(), Some("stopped after 0 s: links may be missing"));
        assert_eq!(got.facts.files.len(), 2, "the files found before the deadline stay graphed");
    }

    #[tokio::test]
    async fn a_deadline_that_has_passed_before_the_patches_sends_every_file_to_other() {
        let source = pair();
        let limits = Limits { deadline: Duration::ZERO, ..QUICK };
        let got = gathered_of(&source, &modified(&["a.py", "b.py"]), &["a.py", "b.py"], &limits).await;
        assert_eq!((got.facts.files.len(), got.facts.other), (0, vec!["a.py".to_owned(), "b.py".into()]));
        assert!(got.facts.note.is_some_and(|n| n.starts_with("stopped after")));
    }

    #[tokio::test]
    async fn patches_are_read_in_batches_and_not_one_call_per_file() {
        let names: Vec<String> = (0..250).map(|i| format!("m{i:03}.py")).collect();
        let source = names.iter().fold(Fake::default(), |s, n| s.file(n, &[2], vec![sym(n, "f", 12, 1, 3)]));
        let refs: Vec<&str> = names.iter().map(String::as_str).collect();
        let got = gathered_of(&source, &modified(&refs), &refs, &QUICK).await;
        assert_eq!(got.facts.files.len(), 250);
        assert_eq!(*source.batches.lock().unwrap(), [100, 100, 50]);
    }

    /// A line that carries enough text to be a move on its own.
    fn code(n: usize) -> String {
        format!("    let value_{n} = compute_total(items, {n});")
    }

    fn block(range: std::ops::Range<usize>) -> Vec<String> {
        range.map(code).collect()
    }

    /// A hunk that adds `text` from new-side line `at`.
    fn added(at: u32, text: &[String]) -> String {
        let body: String = text.iter().map(|l| format!("+{l}\n")).collect();
        format!("@@ -{},0 +{at},{} @@\n{body}", at - 1, text.len())
    }

    /// A hunk that removes `text`; the line after it is now at `at`.
    fn removed(at: u32, text: &[String]) -> String {
        let body: String = text.iter().map(|l| format!("-{l}\n")).collect();
        format!("@@ -{at},{} +{at},0 @@\n{body} context\n", text.len())
    }

    /// The patch of a file deleted with `text` in it.
    fn deleted(text: &[String]) -> String {
        let body: String = text.iter().map(|l| format!("-{l}\n")).collect();
        format!("@@ -1,{} +0,0 @@\n{body}", text.len())
    }

    fn counts(facts: &Facts) -> Vec<(&str, u32)> {
        facts.files.iter().map(|f| (f.path.as_str(), f.symbols)).collect()
    }

    /// `home.py` loses a block that lands in `new.py`; both files hold a symbol around where it was.
    fn moved_pair(landed: &[String]) -> Fake {
        Fake::default().patched("home.py", &removed(3, &block(0..4)), vec![sym("home.py", "stay", 12, 1, 9)]).patched(
            "new.py",
            &added(2, landed),
            vec![sym("new.py", "arrived", 12, 1, 9)],
        )
    }

    #[tokio::test]
    async fn code_that_only_moved_between_files_marks_no_symbol_changed_on_either_side() {
        let source = moved_pair(&block(0..4));
        let facts = facts_of(&source, &modified(&["home.py", "new.py"]), &["home.py", "new.py"]).await;
        assert_eq!(counts(&facts), [("home.py", 0), ("new.py", 0)]);
        assert!(source.asked.lock().unwrap().is_empty(), "no changed symbol, nothing to ask about");
    }

    #[tokio::test]
    async fn a_moved_block_that_was_also_edited_keeps_its_symbol_changed_and_its_arrows() {
        let mut edited = block(0..4);
        edited[2] = code(99);
        let source = moved_pair(&edited).file("user.py", &[2], vec![sym("user.py", "caller", 12, 1, 3)]).replies(
            "new.py",
            1,
            vec![Reply::Found(vec![loc("user.py", 2)])],
        );
        let files = ["home.py", "new.py", "user.py"];
        let facts = facts_of(&source, &modified(&files), &files).await;
        assert_eq!(edges(&facts), ["new.py#1:arrived <- user.py#1:caller"]);
        assert_eq!(counts(&facts)[1], ("new.py", 1));
    }

    #[tokio::test]
    async fn a_move_between_files_read_in_different_batches_is_still_a_move() {
        let names: Vec<String> = (0..150).map(|i| format!("m{i:03}.py")).collect();
        let mut source = names.iter().fold(Fake::default(), |s, n| s.file(n, &[2], vec![sym(n, "f", 12, 1, 3)]));
        source = source.patched("m000.py", &removed(3, &block(0..4)), vec![sym("m000.py", "f", 12, 1, 9)]).patched(
            "m149.py",
            &added(2, &block(0..4)),
            vec![sym("m149.py", "f", 12, 1, 9)],
        );
        let refs: Vec<&str> = names.iter().map(String::as_str).collect();
        let facts = facts_of(&source, &modified(&refs), &refs).await;
        assert_eq!(*source.batches.lock().unwrap(), [100, 50], "the two files sit in different batches");
        let silent: Vec<&str> = counts(&facts).into_iter().filter(|(_, n)| *n == 0).map(|(p, _)| p).collect();
        assert_eq!(silent, ["m000.py", "m149.py"]);
    }

    #[tokio::test]
    async fn a_file_whose_every_change_moved_is_still_listed_and_lands_with_the_unlinked() {
        let source = moved_pair(&block(0..4));
        let facts = facts_of(&source, &modified(&["home.py", "new.py"]), &["home.py", "new.py"]).await;
        assert_eq!(counts(&facts), [("home.py", 0), ("new.py", 0)]);
        let graph = crate::graph::assemble::assemble(facts);
        assert_eq!(
            (graph.unlinked, graph.other, graph.clusters.len()),
            (vec!["home.py".into(), "new.py".into()], vec![], 0)
        );
    }

    #[tokio::test]
    async fn a_deleted_file_is_not_read_when_nothing_is_graphed() {
        let mut source = Fake::default().patched("gone.py", &deleted(&block(0..4)), vec![]);
        source.blocked.insert("a.py".into(), "No language server for python on PATH".into());
        let changed = [change("gone.py", "D", false, false), change("a.py", "M", false, false)];
        let facts = facts_of(&source, &changed, &["a.py"]).await;
        assert_eq!((facts.files.len(), source.batches.lock().unwrap().len()), (0, 0));
    }

    #[tokio::test]
    async fn code_moved_out_of_a_deleted_file_is_a_move_too() {
        let source = Fake::default().patched("gone.py", &deleted(&block(0..4)), vec![]).patched(
            "new.py",
            &added(2, &block(0..4)),
            vec![sym("new.py", "arrived", 12, 1, 9)],
        );
        let changed = [change("gone.py", "D", false, false), change("new.py", "M", false, false)];
        let facts = facts_of(&source, &changed, &["new.py"]).await;
        assert_eq!(counts(&facts), [("new.py", 0)]);
        assert_eq!(facts.other, ["gone.py"]);
    }

    /// What rust-analyzer lists for `enum Kind` and the `impl Kind` beside it.
    fn kind_and_its_impl(path: &str) -> Vec<LspSymbol> {
        let method = LspSymbol { container: Some("impl Kind".into()), ..sym(path, "label", 12, 6, 7) };
        vec![sym(path, "Kind", 10, 1, 3), sym(path, "impl Kind", 19, 5, 8), method]
    }

    #[tokio::test]
    async fn an_impl_block_beside_its_type_is_not_a_second_used_symbol() {
        // Both positions answer with the type's uses, as the real server does.
        let uses = || vec![Reply::Found(vec![loc("user.rs", 2)])];
        let source = Fake::default()
            .file("kind.rs", &[2, 5], kind_and_its_impl("kind.rs"))
            .file("user.rs", &[2], vec![sym("user.rs", "caller", 12, 1, 3)])
            .replies("kind.rs", 1, uses())
            .replies("kind.rs", 5, uses());
        let files = ["kind.rs", "user.rs"];
        let facts = facts_of(&source, &modified(&files), &files).await;
        assert_eq!(edges(&facts), ["kind.rs#1:Kind <- user.rs#1:caller"]);
        assert_eq!(source.asked_at("kind.rs", 5), 0, "the impl is not asked what uses it");
    }

    #[tokio::test]
    async fn an_impl_block_is_still_the_user_of_the_types_in_its_header() {
        // `impl From<Kind> for Thing` at user.rs line 1 mentions `Kind`, declared in kind.rs.
        let header = sym("user.rs", "impl From<Kind> for Thing", 19, 1, 4);
        let source = Fake::default()
            .file("kind.rs", &[2], vec![sym("kind.rs", "Kind", 10, 1, 3)])
            .file("user.rs", &[1], vec![header])
            .replies("kind.rs", 1, vec![Reply::Found(vec![loc("user.rs", 1)])]);
        let files = ["kind.rs", "user.rs"];
        let facts = facts_of(&source, &modified(&files), &files).await;
        assert_eq!(edges(&facts), ["kind.rs#1:Kind <- user.rs#1:impl From<Kind> for Thing"]);
        assert_eq!(source.asked_at("user.rs", 1), 0, "as the user it is looked up in, not asked about");
    }

    #[tokio::test]
    async fn the_methods_of_an_impl_block_stay_subjects() {
        let source = Fake::default()
            .file("kind.rs", &[1, 6], kind_and_its_impl("kind.rs"))
            .file("user.rs", &[2], vec![sym("user.rs", "caller", 12, 1, 3)])
            .replies("kind.rs", 6, vec![Reply::Found(vec![loc("user.rs", 2)])]);
        let files = ["kind.rs", "user.rs"];
        let facts = facts_of(&source, &modified(&files), &files).await;
        assert_eq!(edges(&facts), ["kind.rs#6:label <- user.rs#1:caller"]);
    }

    #[tokio::test]
    async fn only_rust_names_an_impl_block_so() {
        // A python function called `impl Kind` is a symbol like any other.
        let source = Fake::default()
            .file("kind.py", &[2], vec![sym("kind.py", "impl Kind", 12, 1, 3)])
            .file("user.py", &[2], vec![sym("user.py", "caller", 12, 1, 3)])
            .replies("kind.py", 1, vec![Reply::Found(vec![loc("user.py", 2)])]);
        let files = ["kind.py", "user.py"];
        let facts = facts_of(&source, &modified(&files), &files).await;
        assert_eq!(edges(&facts), ["kind.py#1:impl Kind <- user.py#1:caller"]);
    }
}
