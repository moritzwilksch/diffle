//! Pure shaping of a `textDocument/hover` answer into one markdown string.
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use async_lsp::lsp_types::{HoverContents, MarkedString, MarkupKind};
use regex::{Captures, Regex};

/// An inline markdown link whose target is a `file:` URI, as pyright and pyrefly write "Go to X".
static FILE_LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[([^\]]*)\]\(\s*<?(file:[^\s)>]+)>?\s*\)").unwrap());
static BACKTICKS: LazyLock<Regex> = LazyLock::new(|| Regex::new("`+").unwrap());

/// One markdown document for the tooltip, or none when the server sent nothing worth showing.
/// Plaintext and `{language, value}` parts become fenced blocks, so their text is never re-read as
/// markdown.
pub fn hover_markdown(contents: &HoverContents) -> Option<String> {
    let parts: Vec<String> = match contents {
        HoverContents::Scalar(one) => vec![marked(one)],
        HoverContents::Array(list) => list.iter().map(marked).collect(),
        HoverContents::Markup(m) if m.kind == MarkupKind::Markdown => vec![m.value.clone()],
        HoverContents::Markup(m) => vec![fence(&m.value, "")],
    };
    let parts: Vec<String> = parts.into_iter().filter(|p| !p.trim().is_empty()).collect();
    (!parts.is_empty()).then(|| parts.join("\n\n"))
}

fn marked(part: &MarkedString) -> String {
    match part {
        MarkedString::String(md) => md.clone(),
        MarkedString::LanguageString(code) => fence(&code.value, &code.language),
    }
}

/// A fence long enough that a backtick run inside the code cannot close it early.
fn fence(code: &str, lang: &str) -> String {
    let longest = BACKTICKS.find_iter(code).map(|m| m.len()).max().unwrap_or(0).max(2);
    let ticks = "`".repeat(longest + 1);
    format!("{ticks}{lang}\n{}\n{ticks}", code.strip_suffix('\n').unwrap_or(code))
}

/// The `file:` URIs the hover text links to, each once, in order.
pub fn file_link_uris(md: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    FILE_LINK.captures_iter(md).map(|m| m[2].to_owned()).filter(|uri| seen.insert(uri.clone())).collect()
}

/// Rewrites the hover text's `file:` links to `diffle:<path>#L<line>`, which the client follows as
/// an in-app jump. `resolved` maps each URI to its repo-relative path and line; a URI it omits lies
/// outside the repository and becomes plain text.
pub fn localize_file_links(md: &str, resolved: &HashMap<String, (String, Option<i64>)>) -> String {
    FILE_LINK
        .replace_all(md, |m: &Captures| match resolved.get(&m[2]) {
            None => m[1].to_owned(),
            Some((path, line)) => {
                let line = line.map_or_else(String::new, |l| format!("#L{l}"));
                format!("[{}](diffle:{}{line})", &m[1], encode_uri(path))
            }
        })
        .into_owned()
}

/// `encodeURI`: everything but the characters a URI may carry as they are.
fn encode_uri(s: &str) -> String {
    const KEEP: &str = "-_.!~*'();/?:@&=+$,#";
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || KEEP.as_bytes().contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn md(v: serde_json::Value) -> Option<String> {
        hover_markdown(&serde_json::from_value(v).unwrap())
    }

    #[test]
    fn passes_markdown_through_and_drops_empty_results() {
        assert_eq!(md(json!({ "kind": "markdown", "value": "**f**" })).as_deref(), Some("**f**"));
        assert_eq!(md(json!("plain md")).as_deref(), Some("plain md"));
        assert_eq!(md(json!([])), None);
        assert_eq!(md(json!({ "kind": "markdown", "value": "  \n" })), None);
    }

    #[test]
    fn fences_plaintext_and_language_blocks_longer_than_any_backtick_run_inside() {
        assert_eq!(md(json!({ "kind": "plaintext", "value": "x: int\n" })).as_deref(), Some("```\nx: int\n```"));
        let block = md(json!({ "language": "python", "value": "a = ``` + 1" }));
        assert_eq!(block.as_deref(), Some("````python\na = ``` + 1\n````"));
        let mixed = md(json!([{ "language": "python", "value": "def f() -> None" }, "Does the `f` thing."]));
        assert_eq!(mixed.as_deref(), Some("```python\ndef f() -> None\n```\n\nDoes the `f` thing."));
    }

    #[test]
    fn rewrites_links_inside_the_repository_and_drops_the_others() {
        let md =
            "Go to [f](file:///r/a%20b.py#3,4) or [site](<file:///usr/site.py#10>) and [f](file:///r/a%20b.py#3,4)";
        assert_eq!(file_link_uris(md), ["file:///r/a%20b.py#3,4", "file:///usr/site.py#10"]);
        let resolved = HashMap::from([("file:///r/a%20b.py#3,4".to_owned(), ("a b.py".to_owned(), Some(3)))]);
        assert_eq!(
            localize_file_links(md, &resolved),
            "Go to [f](diffle:a%20b.py#L3) or site and [f](diffle:a%20b.py#L3)"
        );
    }
}
