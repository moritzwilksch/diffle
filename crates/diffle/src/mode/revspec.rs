//! Parsing revision arguments as `git diff` and `git range-diff` take them.
use crate::error::{Error, Result};
use crate::git::WORKTREE;
use crate::protocol::ComparisonBase;

/// What revision arguments name: a range, or one commit against its first parent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ParsedRevspec {
    Range { old: String, new: String, base: ComparisonBase },
    Commit(String),
}

/// A range of a range-diff as named: `old..new`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedRange {
    pub old: String,
    pub new: String,
}

fn spec(old: &str, new: &str, base: ComparisonBase) -> ParsedRevspec {
    ParsedRevspec::Range { old: old.to_owned(), new: new.to_owned(), base }
}

fn or_head(rev: &str) -> &str {
    if rev.is_empty() { "HEAD" } else { rev }
}

/// git-diff style revision arguments:
///   "a"      → merge-base(a, HEAD) vs HEAD, i.e. "a...HEAD"
///   "a..b"   → a vs b
///   "a...b"  → merge-base(a, b) vs b
///   "a" "b"  → a vs b
///   "a^!"    → a vs its first parent: the one commit, as git show shows it
/// Empty sides default to HEAD. Either side accepts "worktree" for the uncommitted tree; a merge
/// base against it is taken against HEAD, the commit it sits on.
pub fn parse_revspec(args: &[String]) -> Result<ParsedRevspec> {
    match args {
        [a, b] => {
            if a.contains("..") || b.contains("..") {
                return Err(Error::revspec("cannot combine \"..\" with two revisions"));
            }
            if a.ends_with("^!") || b.ends_with("^!") {
                return Err(Error::revspec("cannot combine \"^!\" with two revisions"));
            }
            Ok(spec(a, b, ComparisonBase::Direct))
        }
        [arg] => {
            if let Some(commit) = arg.strip_suffix("^!") {
                let commit = or_head(commit);
                if commit.contains("..") {
                    return Err(Error::revspec("cannot combine \"^!\" with \"..\""));
                }
                if commit == WORKTREE {
                    return Err(Error::revspec("the worktree is not a commit"));
                }
                return Ok(ParsedRevspec::Commit(commit.to_owned()));
            }
            if let Some((a, b)) = arg.split_once("...") {
                return Ok(spec(or_head(a), or_head(b), ComparisonBase::MergeBase));
            }
            if let Some((a, b)) = arg.split_once("..") {
                return Ok(spec(or_head(a), or_head(b), ComparisonBase::Direct));
            }
            // A lone revision reviews what it and HEAD diverged into: the everyday "my branch" diff.
            if arg == WORKTREE {
                return Ok(spec("HEAD", WORKTREE, ComparisonBase::Direct));
            }
            Ok(spec(arg, "HEAD", ComparisonBase::MergeBase))
        }
        _ => Err(Error::revspec("expected one or two revisions")),
    }
}

const RANGE_DIFF_USAGE: &str = "expected <range1> <range2>, <rev1>...<rev2> or <base> <rev1> <rev2>";

/// `git range-diff` style arguments, as two `old..new` ranges:
///   "a..b" "c..d"  → a..b against c..d
///   "base" "b" "d" → base..b against base..d
///   "b...d"        → d..b against b..d: each tip's commits since their divergence
/// A range also takes `<rev>^!`, the one commit. Empty sides default to HEAD; the worktree is not
/// a commit and has no place in a range.
pub fn parse_range_diff(args: &[String]) -> Result<(ParsedRange, ParsedRange)> {
    match args {
        [base, b, d] => {
            if args.iter().any(|arg| arg.contains("..") || arg.ends_with("^!")) {
                return Err(Error::revspec("expected <base> <rev1> <rev2> as three plain revisions"));
            }
            Ok((range(base, b)?, range(base, d)?))
        }
        [a, b] => Ok((parse_range(a)?, parse_range(b)?)),
        [arg] => {
            let Some((b, d)) = arg.split_once("...").filter(|_| !arg.ends_with("^!")) else {
                return Err(Error::revspec(RANGE_DIFF_USAGE));
            };
            let (b, d) = (or_head(b), or_head(d));
            if b.contains("..") || d.contains("..") {
                return Err(Error::revspec("cannot combine \"...\" with \"..\""));
            }
            Ok((range(d, b)?, range(b, d)?))
        }
        _ => Err(Error::revspec(RANGE_DIFF_USAGE)),
    }
}

fn parse_range(arg: &str) -> Result<ParsedRange> {
    if let Some(commit) = arg.strip_suffix("^!") {
        let commit = or_head(commit);
        if commit.contains("..") {
            return Err(Error::revspec("cannot combine \"^!\" with \"..\""));
        }
        return range(&format!("{commit}^"), commit);
    }
    if arg.contains("...") {
        return Err(Error::revspec(format!("a range of a range-diff is <old>..<new>, not {arg}")));
    }
    let Some((old, new)) = arg.split_once("..") else {
        return Err(Error::revspec(format!("not a range: {arg} (expected <old>..<new>)")));
    };
    range(or_head(old), or_head(new))
}

fn range(old: &str, new: &str) -> Result<ParsedRange> {
    if [old, new].iter().any(|rev| *rev == WORKTREE || *rev == "worktree^") {
        return Err(Error::revspec("the worktree is not a commit"));
    }
    Ok(ParsedRange { old: old.to_owned(), new: new.to_owned() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ComparisonBase::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    fn parsed(list: &[&str]) -> ParsedRevspec {
        parse_revspec(&args(list)).unwrap()
    }

    fn err(list: &[&str]) -> String {
        parse_revspec(&args(list)).unwrap_err().to_string()
    }

    #[test]
    fn reads_revspecs_as_git_diff_does() {
        let t = |old: &str, new: &str, base| ParsedRevspec::Range { old: old.to_owned(), new: new.to_owned(), base };
        assert_eq!(parsed(&["main"]), t("main", "HEAD", MergeBase));
        assert_eq!(parsed(&["main..feat"]), t("main", "feat", Direct));
        assert_eq!(parsed(&["main..."]), t("main", "HEAD", MergeBase));
        assert_eq!(parsed(&["..feat"]), t("HEAD", "feat", Direct));
        assert_eq!(parsed(&["a", "b"]), t("a", "b", Direct));
        assert_eq!(parsed(&["abc^!"]), ParsedRevspec::Commit("abc".into()));
        assert_eq!(parsed(&["^!"]), ParsedRevspec::Commit("HEAD".into()));
        assert_eq!(parsed(&["worktree"]), t("HEAD", "worktree", Direct));
        assert_eq!(parsed(&["main...worktree"]), t("main", "worktree", MergeBase));
    }

    #[test]
    fn refuses_what_git_diff_would_not_mean() {
        assert_eq!(err(&[]), "expected one or two revisions");
        assert_eq!(err(&["a", "b", "c"]), "expected one or two revisions");
        assert_eq!(err(&["a..b", "c"]), "cannot combine \"..\" with two revisions");
        assert_eq!(err(&["a^!", "c"]), "cannot combine \"^!\" with two revisions");
        assert_eq!(err(&["a..b^!"]), "cannot combine \"^!\" with \"..\"");
        assert_eq!(err(&["worktree^!"]), "the worktree is not a commit");
    }

    #[test]
    fn reads_range_diffs_as_git_range_diff_does() {
        let r = |old: &str, new: &str| ParsedRange { old: old.into(), new: new.into() };
        assert_eq!(parse_range_diff(&args(&["a..b", "c..d"])).unwrap(), (r("a", "b"), r("c", "d")));
        assert_eq!(parse_range_diff(&args(&["base", "b", "d"])).unwrap(), (r("base", "b"), r("base", "d")));
        assert_eq!(parse_range_diff(&args(&["b...d"])).unwrap(), (r("d", "b"), r("b", "d")));
        assert_eq!(parse_range_diff(&args(&["x^!", "..y"])).unwrap(), (r("x^", "x"), r("HEAD", "y")));
        let err = |list: &[&str]| parse_range_diff(&args(list)).unwrap_err().to_string();
        assert_eq!(err(&["a"]), RANGE_DIFF_USAGE);
        assert_eq!(err(&["a...b", "c..d"]), "a range of a range-diff is <old>..<new>, not a...b");
        assert_eq!(err(&["a", "c..d"]), "not a range: a (expected <old>..<new>)");
        assert_eq!(err(&["worktree..a", "c..d"]), "the worktree is not a commit");
        assert_eq!(err(&["a..b", "c", "d"]), "expected <base> <rev1> <rev2> as three plain revisions");
    }
}
