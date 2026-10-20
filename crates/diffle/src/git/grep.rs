//! Searching the new side, bounded at the process boundary.
use std::collections::HashMap;
use std::time::Duration;

use super::exec::{RecordOptions, exec_records};
use super::{GitRepo, WORKTREE};
use crate::error::GitError;

/// A search that runs this long is a runaway regex, not a slow repository.
const GREP_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Default)]
pub struct GrepOptions<'a> {
    /// Whole words only (vim's `*`).
    pub word: bool,
    pub ignore_case: bool,
    /// An extended regex instead of a fixed string.
    pub regex: bool,
    /// Restricts files; an empty list matches nothing.
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
    /// Search the new side, case-sensitive unless asked otherwise. Worktree searches include
    /// untracked files. Git is stopped once `limit + 1` records have arrived, so a common query in
    /// a large repository cannot flood the process.
    pub async fn grep(
        &self,
        query: &str,
        rev: &str,
        limit: usize,
        opts: GrepOptions<'_>,
    ) -> Result<GrepResult, GitError> {
        // An explicit empty path list means "search nothing": with no pathspec git would search everything.
        if query.is_empty()
            || opts.paths.is_some_and(<[String]>::is_empty)
            || opts.ranges.is_some_and(HashMap::is_empty)
        {
            return Ok(GrepResult { matches: Vec::new(), truncated: false });
        }
        // --no-column: `grep.column=true` would splice a column field into the -z record.
        let mut args = vec!["grep", "-n", "--no-column", "-I", if opts.regex { "-E" } else { "-F" }, "-z"];
        // Filtering must precede the limit: early matches outside hunks must not hide later visible hits.
        let max_count = format!("--max-count={}", limit + 1);
        if opts.ranges.is_none() {
            args.push(&max_count);
        }
        if opts.word {
            args.push("-w");
        }
        if opts.ignore_case {
            args.push("-i");
        }
        args.extend(["-e", query]);
        args.push(if rev == WORKTREE { "--untracked" } else { rev });
        args.push("--");
        // Literal pathspecs: a path with `*` or `?` in it must not turn into a glob.
        let literal: Vec<String> = opts.paths.unwrap_or_default().iter().map(|p| format!(":(literal){p}")).collect();
        args.extend(literal.iter().map(String::as_str));
        let parse = |record: &str| parse_record(record, rev != WORKTREE);
        let accept = opts.ranges.map(|ranges| {
            move |record: &str| {
                let m = parse(record);
                ranges.get(&m.path).is_some_and(|r| r.iter().any(|&(start, end)| m.line >= start && m.line <= end))
            }
        });
        let records = exec_records(
            &self.root,
            &args,
            limit + 1,
            RecordOptions {
                ok_codes: &[0, 1],
                timeout: GREP_TIMEOUT,
                accept: accept.as_ref().map(|f| f as &(dyn Fn(&str) -> bool + Sync)),
            },
        )
        .await?;
        let truncated = records.len() > limit;
        Ok(GrepResult { matches: records.iter().take(limit).map(|r| parse(r)).collect(), truncated })
    }
}

/// `-z`: "path\0line\0text" per match; with a rev the path is "rev:path".
fn parse_record(record: &str, with_rev: bool) -> GrepMatch {
    let mut fields = record.splitn(3, '\0');
    let raw = fields.next().unwrap_or_default();
    let path = if with_rev { raw.split_once(':').map_or(raw, |(_, p)| p) } else { raw };
    let line = fields.next().and_then(|l| l.parse().ok()).unwrap_or(0);
    let text = fields.next().unwrap_or_default().chars().take(300).collect();
    GrepMatch { path: path.to_owned(), line, text }
}
