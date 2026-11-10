//! Syntax tokens for one side of a file, with bat's grammars (two-face) on syntect.
use std::collections::HashMap;
use std::path::Path;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use syntect::easy::ScopeRangeIterator;
use syntect::parsing::{ParseState, Scope, ScopeStack, SyntaxReference, SyntaxSet};
use syntect::util::LinesWithEndings;

use crate::protocol::{Token, TokenKind};

/// Larger sides go unhighlighted: grammars are regex machines, and a review must not wait on one.
const MAX_BYTES: usize = 1 << 20;
/// A longer line (minified code) makes the side unhighlighted, for the same reason.
const MAX_LINE_BYTES: usize = 10_000;
/// Past this, highlighting stops and the remaining lines stay plain. A release build does a
/// 10,000-line Markdown file in under a second; this bounds a grammar that backtracks badly.
const BUDGET: Duration = Duration::from_secs(2);

static SYNTAXES: LazyLock<SyntaxSet> = LazyLock::new(two_face::syntax::extra_newlines);

/// The grammar's name and the tokens of each line (fewer than the lines past `BUDGET`), or none when no grammar matches `path` or the
/// text is binary, too large or trips the grammar.
pub fn highlight(path: &str, text: &[u8]) -> Option<(String, Vec<Vec<Token>>)> {
    if text.len() > MAX_BYTES || crate::git::is_binary(text) {
        return None;
    }
    let text = String::from_utf8_lossy(text);
    let syntax = syntax_for(path, &text)?;
    let mut state = ParseState::new(syntax);
    let mut stack = ScopeStack::new();
    let mut kinds = HashMap::new();
    let mut lines = Vec::new();
    let started = Instant::now();
    for line in LinesWithEndings::from(&text) {
        if started.elapsed() > BUDGET {
            break;
        }
        if line.len() > MAX_LINE_BYTES {
            return None;
        }
        let ops = state.parse_line(line, &SYNTAXES).ok()?;
        let content = line.trim_end_matches(['\n', '\r']).len();
        let mut tokens: Vec<Token> = Vec::new();
        let mut cursor = Utf16Cursor::default();
        for (range, op) in ScopeRangeIterator::new(&ops, line) {
            stack.apply(op).ok()?;
            let (start, end) = (range.start.min(content), range.end.min(content));
            if start == end {
                continue;
            }
            let Some(kind) = kind_of(&stack, &mut kinds) else { continue };
            let (start, end) = (cursor.advance(line, start), cursor.advance(line, end));
            match tokens.last_mut() {
                Some(last) if last.kind == kind && last.end == start => last.end = end,
                _ => tokens.push(Token { start, end, kind }),
            }
        }
        lines.push(tokens);
    }
    Some((syntax.name.clone(), lines))
}

fn syntax_for(path: &str, text: &str) -> Option<&'static SyntaxReference> {
    let path = Path::new(path);
    let by = |name: Option<&std::ffi::OsStr>| name.and_then(|n| SYNTAXES.find_syntax_by_extension(n.to_str()?));
    // Whole names first (`Makefile`, `Dockerfile`), as syntect lists them among the extensions.
    by(path.file_name())
        .or_else(|| by(path.extension()))
        .or_else(|| SYNTAXES.find_syntax_by_first_line(text.lines().next()?))
        .filter(|s| s.name != "Plain Text")
}

/// Converts the ascending byte offsets of one line to UTF-16 columns in one pass.
#[derive(Default)]
struct Utf16Cursor {
    byte: usize,
    utf16: i64,
}

impl Utf16Cursor {
    fn advance(&mut self, line: &str, byte: usize) -> i64 {
        self.utf16 += line[self.byte..byte].encode_utf16().count() as i64;
        self.byte = byte;
        self.utf16
    }
}

/// The innermost scope with a rule decides; `cache` remembers each scope's rule.
fn kind_of(stack: &ScopeStack, cache: &mut HashMap<Scope, Option<Rule>>) -> Option<TokenKind> {
    for scope in stack.as_slice().iter().rev() {
        let rule = *cache.entry(*scope).or_insert_with(|| rule_for(&scope.build_string()));
        match rule {
            Some(Rule::Kind(kind)) => return Some(kind),
            Some(Rule::Plain) => return None,
            None => {}
        }
    }
    None
}

#[derive(Clone, Copy)]
enum Rule {
    Kind(TokenKind),
    /// Code inside code (string interpolation, a fenced block) is not the outer token's color.
    Plain,
}

/// TextMate scope prefixes, more specific before less within a family. Matched per atom:
/// `string` matches `string.quoted.rust`, not `stringy`.
const RULES: &[(&str, Rule)] = {
    use Rule::{Kind, Plain};
    use TokenKind as K;
    &[
        ("comment", Kind(K::Comment)),
        ("meta.embedded", Plain),
        ("meta.interpolation", Plain),
        ("source", Plain),
        ("string.other.link", Kind(K::Link)),
        ("markup.underline.link", Kind(K::Link)),
        ("string", Kind(K::String)),
        ("markup.raw", Kind(K::String)),
        ("constant.numeric", Kind(K::Number)),
        ("constant", Kind(K::Constant)),
        ("support.constant", Kind(K::Constant)),
        ("variable.other.constant", Kind(K::Constant)),
        ("entity.name.constant", Kind(K::Constant)),
        ("keyword.operator", Kind(K::Operator)),
        ("keyword", Kind(K::Keyword)),
        ("storage", Kind(K::Keyword)),
        ("variable.language", Kind(K::Keyword)),
        ("entity.name.function", Kind(K::Function)),
        ("support.function", Kind(K::Function)),
        ("variable.function", Kind(K::Function)),
        ("support.macro", Kind(K::Function)),
        ("entity.name.macro", Kind(K::Function)),
        ("entity.name.tag", Kind(K::Tag)),
        ("entity.other.attribute-name", Kind(K::Attribute)),
        ("meta.annotation", Kind(K::Attribute)),
        ("entity.name.section", Kind(K::Heading)),
        ("markup.heading", Kind(K::Heading)),
        ("support.type.property-name", Kind(K::Property)),
        ("variable.other.member", Kind(K::Property)),
        ("variable.other.property", Kind(K::Property)),
        ("meta.object-literal.key", Kind(K::Property)),
        ("entity.name", Kind(K::Type)),
        ("entity.other.inherited-class", Kind(K::Type)),
        ("support.type", Kind(K::Type)),
        ("support.class", Kind(K::Type)),
        ("variable.parameter", Kind(K::Variable)),
    ]
};

fn rule_for(scope: &str) -> Option<Rule> {
    let matches =
        |prefix: &str| scope.strip_prefix(prefix).is_some_and(|rest| rest.is_empty() || rest.starts_with('.'));
    RULES.iter().find(|(prefix, _)| matches(prefix)).map(|(_, rule)| *rule)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(path: &str, text: &str) -> Vec<Vec<(String, TokenKind)>> {
        let (_, lines) = highlight(path, text.as_bytes()).expect("a grammar");
        let text: Vec<Vec<u16>> = text.lines().map(|l| l.encode_utf16().collect()).collect();
        lines
            .iter()
            .zip(&text)
            .map(|(tokens, line)| {
                let piece = |t: &Token| String::from_utf16_lossy(&line[t.start as usize..t.end as usize]);
                tokens.iter().map(|t| (piece(t), t.kind)).collect()
            })
            .collect()
    }

    #[test]
    fn highlights_rust() {
        let lines = kinds("src/a.rs", "// hi\nfn main() { let x = \"s\"; 42 }\n");
        assert_eq!(lines[0], [("// hi".into(), TokenKind::Comment)]);
        assert!(lines[1].contains(&("fn".into(), TokenKind::Keyword)), "{:?}", lines[1]);
        assert!(lines[1].contains(&("main".into(), TokenKind::Function)), "{:?}", lines[1]);
        assert!(lines[1].contains(&("\"s\"".into(), TokenKind::String)), "{:?}", lines[1]);
        assert!(lines[1].contains(&("42".into(), TokenKind::Number)), "{:?}", lines[1]);
    }

    #[test]
    fn carries_state_across_lines() {
        let lines = kinds("a.ts", "/* one\ntwo */ const x = 1;\n");
        assert_eq!(lines[1][0], ("two */".into(), TokenKind::Comment));
    }

    #[test]
    fn counts_utf16_columns() {
        let lines = kinds("a.py", "s = \"😀\" # ü\n");
        assert!(lines[0].contains(&("\"😀\"".into(), TokenKind::String)), "{:?}", lines[0]);
        assert!(lines[0].contains(&("# ü".into(), TokenKind::Comment)), "{:?}", lines[0]);
    }

    #[test]
    fn leaves_unknown_binary_and_huge_files_alone() {
        assert!(highlight("notes.unknownext", b"hello\n").is_none());
        assert!(highlight("a.rs", b"fn\0main").is_none());
        assert!(highlight("a.js", "x".repeat(MAX_LINE_BYTES + 1).as_bytes()).is_none());
    }

    #[test]
    fn finds_grammars_by_name_and_first_line() {
        assert!(highlight("Makefile", b"all:\n\techo hi\n").is_some());
        assert!(highlight("bin/run", b"#!/usr/bin/env bash\necho hi\n").is_some());
    }
}
