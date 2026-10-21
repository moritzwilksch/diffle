//! One realistic export, pinned as a snapshot, so a change to the format is judged by reading the
//! prompt an agent would receive.
use diffle::comments::format::format_prompt;
use diffle::protocol::{CommentAnchor, CommentMessage, CommentThread, Side};

fn msg(id: &str, body: &str, at: i64) -> CommentMessage {
    CommentMessage { id: id.into(), body: body.into(), created_at: at, updated_at: at }
}

fn line(path: &str, side: Side, start: i64, end: i64, quoted: &str) -> CommentAnchor {
    CommentAnchor::Line { path: path.into(), side, start_line: start, end_line: end, quoted: quoted.into() }
}

fn thread(id: &str, anchor: CommentAnchor, messages: Vec<CommentMessage>) -> CommentThread {
    CommentThread {
        id: id.into(),
        anchor,
        messages,
        resolved: false,
        resolved_at: None,
        stale: false,
        stale_from_line: None,
    }
}

fn basic(over: impl FnOnce(&mut CommentThread)) -> CommentThread {
    let mut t = thread("x", line("src/a.py", Side::New, 3, 3, "def foo():"), vec![msg("m", "Rename this.", 1)]);
    over(&mut t);
    t
}

#[test]
fn renders_ranges_multi_line_quotes_removed_side_and_stale_prefixes() {
    let removed = basic(|t| t.anchor = line("src/a.py", Side::Old, 3, 4, "a\n\nb"));
    let stale = basic(|t| {
        t.stale = true;
        t.stale_from_line = Some(9);
        t.anchor = line("src/b.py", Side::New, 3, 3, "def foo():");
    });
    assert_eq!(
        format_prompt(&[removed, stale]),
        "(removed) src/a.py:3-4\n\n> a\n>\n> b\n\nRename this.\n\n---\n\n(stale, was line 9) src/b.py:3\n\n> def foo():\n\nRename this.\n\n---\n"
    );
}

#[test]
fn renders_a_thread_on_the_whole_file_with_a_file_prefix_and_no_quote_its_fences_as_written() {
    let file = basic(|t| {
        t.anchor = CommentAnchor::File { path: "src/a.py".into() };
        t.messages = vec![msg("m", "Split this module.", 1), msg("m", "```suggestion\nx\n```", 1)];
    });
    assert_eq!(
        format_prompt(std::slice::from_ref(&file)),
        "(file) src/a.py\n\nSplit this module.\n\n```suggestion\nx\n```\n\n---\n"
    );
    let stale = CommentThread { stale: true, ..file };
    assert!(format_prompt(&[stale]).starts_with("(file) (stale) src/a.py\n"));
}

#[test]
fn reads_as_an_agent_would_receive_it() {
    let mut stale = thread(
        "cli-stale",
        line("tally/cli.py", Side::New, 27, 27, "print(\"no entries\", file=sys.stderr)"),
        vec![msg("e1", "Exit code 1 for \"nothing to do\" will trip `set -e` in the cron wrapper.", 60)],
    );
    stale.stale = true;
    stale.stale_from_line = Some(26);
    let threads = [
        thread(
            "ledger-kind",
            line(
                "tally/ledger.py",
                Side::New,
                3,
                4,
                "A line is a sale unless its ``kind`` column says ``refund``; refunds count negative.\n\"\"\"",
            ),
            vec![
                msg("a1", "Say what counts as a refund here, not only in the parser.", 10),
                msg("a2", "Also link the release notes once they mention `kind`.", 20),
            ],
        ),
        thread(
            "currency-symbol",
            line(
                "tally/currency.py",
                Side::New,
                7,
                7,
                "_SYMBOLS = {\"EUR\": \"€\", \"USD\": \"$\", \"GBP\": \"£\", \"JPY\": \"¥\"}",
            ),
            vec![msg(
                "b1",
                "`KWD` gets three decimals above but no symbol here.\n\n```suggestion\n_SYMBOLS = {\"EUR\": \"€\", \"USD\": \"$\", \"GBP\": \"£\", \"JPY\": \"¥\", \"KWD\": \"KD\"}\n```",
                30,
            )],
        ),
        thread(
            "legacy-removed",
            line(
                "tally/legacy.py",
                Side::Old,
                9,
                15,
                "def read_tsv(path: Path) -> Ledger:\n    ledger = Ledger()\n    for line in path.read_text().splitlines():\n        if not line or line.startswith(\"#\"):\n            continue\n        account, description, quantity, unit_price = line.split(\"\\t\")\n        ledger.add(Entry(account, description, int(quantity), Decimal(unit_price)))",
            ),
            vec![msg("c1", "Is the archive really converted? The cron job still calls this.", 40)],
        ),
        thread(
            "refunds-file",
            CommentAnchor::File { path: "tally/refunds.py".into() },
            vec![msg("d1", "Consider folding this into `ledger.py`; it only has two callers.", 50)],
        ),
        stale,
    ];
    insta::assert_snapshot!(format_prompt(&threads));
}
