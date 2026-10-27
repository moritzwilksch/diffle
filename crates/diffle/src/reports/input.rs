//! A report as authored, checked and resolved into one as served: every named file a key, every
//! anchor a place the snapshot shows, every limit kept.
use std::collections::HashMap;

use crate::error::{Error, Result};
use crate::protocol::{
    ReportAnchor, ReportBlock, ReportBlockInput, ReportFile, ReportInput, ReportPage, ReportPageInput, Side,
};

/// The most blocks one report holds; a reviewer reads a report, not a dump.
pub const MAX_BLOCKS: usize = 200;
/// The most pages one block holds.
pub const MAX_PAGES: usize = 500;
/// The longest markdown block, in bytes.
pub const MAX_MARKDOWN_BYTES: usize = 256 * 1024;
pub const MAX_TITLE_CHARS: usize = 120;
pub const MAX_SUMMARY_CHARS: usize = 200;
pub const MAX_LABEL_CHARS: usize = 80;

/// A report checked and resolved; `notes` says what was dropped on the way.
#[derive(Debug)]
pub struct Validated {
    pub title: String,
    pub summary: String,
    pub blocks: Vec<ReportBlock>,
    pub notes: Vec<String>,
}

/// `id` as the API takes it: a lowercase word of letters, digits and dashes, at most 64 long.
pub fn check_id(id: &str) -> Result<()> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if ok { Ok(()) } else { Err(invalid("id: lowercase letters, digits and dashes, at most 64")) }
}

/// Whether `path` names a file next to a report: relative, with no `..` or empty segment, and no
/// backslash, so it names the same file on every platform.
pub fn safe_relative(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.contains('\0')
        && path.split('/').all(|seg| !seg.is_empty() && seg != "." && seg != "..")
}

fn invalid(message: impl Into<String>) -> Error {
    Error::Invalid(message.into())
}

/// Checks `input` and resolves it against `files`, the uploaded files by authored path, and
/// `shown`, which says whether a path is in the snapshot on a side. A file the report names but
/// nobody uploaded fails; an anchor nothing shows is dropped with a note.
pub fn validate(
    input: ReportInput,
    files: &HashMap<String, ReportFile>,
    shown: impl Fn(&str, Side) -> bool,
) -> Result<Validated> {
    let title = input.title.trim().to_owned();
    if title.is_empty() {
        return Err(invalid("title: required"));
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(invalid(format!("title: at most {MAX_TITLE_CHARS} characters")));
    }
    if input.blocks.len() > MAX_BLOCKS {
        return Err(invalid(format!("blocks: at most {MAX_BLOCKS}")));
    }
    let mut notes = Vec::new();
    let mut blocks = Vec::with_capacity(input.blocks.len());
    for (i, block) in input.blocks.into_iter().enumerate() {
        blocks.push(resolve_block(i, block, files, &shown, &mut notes)?);
    }
    let summary = match input.summary.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()) {
        Some(s) if s.chars().count() > MAX_SUMMARY_CHARS => {
            return Err(invalid(format!("summary: at most {MAX_SUMMARY_CHARS} characters")));
        }
        Some(s) => s,
        None => first_line(&blocks),
    };
    Ok(Validated { title, summary, blocks, notes })
}

fn resolve_block(
    i: usize,
    block: ReportBlockInput,
    files: &HashMap<String, ReportFile>,
    shown: &impl Fn(&str, Side) -> bool,
    notes: &mut Vec<String>,
) -> Result<ReportBlock> {
    match block {
        ReportBlockInput::Markdown { text, anchor } => {
            if text.len() > MAX_MARKDOWN_BYTES {
                return Err(invalid(format!("blocks[{i}].text: at most {MAX_MARKDOWN_BYTES} bytes")));
            }
            let anchor = anchor.and_then(|a| placed(a, &format!("blocks[{i}]"), shown, notes));
            Ok(ReportBlock::Markdown { text, anchor })
        }
        ReportBlockInput::Pages { label, pages } => {
            if pages.len() > MAX_PAGES {
                return Err(invalid(format!("blocks[{i}].pages: at most {MAX_PAGES}")));
            }
            let label = label.map(|l| l.trim().to_owned()).filter(|l| !l.is_empty());
            if label.as_ref().is_some_and(|l| l.chars().count() > MAX_LABEL_CHARS) {
                return Err(invalid(format!("blocks[{i}].label: at most {MAX_LABEL_CHARS} characters")));
            }
            let pages = pages
                .into_iter()
                .enumerate()
                .map(|(j, page)| resolve_page(&format!("blocks[{i}].pages[{j}]"), page, files, shown, notes))
                .collect::<Result<Vec<_>>>()?;
            Ok(ReportBlock::Pages { label, pages })
        }
    }
}

fn resolve_page(
    at: &str,
    page: ReportPageInput,
    files: &HashMap<String, ReportFile>,
    shown: &impl Fn(&str, Side) -> bool,
    notes: &mut Vec<String>,
) -> Result<ReportPage> {
    if page.label.chars().count() > MAX_LABEL_CHARS {
        return Err(invalid(format!("{at}.label: at most {MAX_LABEL_CHARS} characters")));
    }
    if page.old.is_none() && page.new.is_none() {
        return Err(invalid(format!("{at}: a page needs an old or a new file")));
    }
    let file = |side: &str, path: Option<String>| -> Result<Option<ReportFile>> {
        let Some(path) = path else { return Ok(None) };
        if !safe_relative(&path) {
            return Err(invalid(format!("{at}.{side}: a relative path under the report's files, got \"{path}\"")));
        }
        files
            .get(&path)
            .cloned()
            .map(Some)
            .ok_or_else(|| invalid(format!("{at}.{side}: no file uploaded as \"{path}\"")))
    };
    Ok(ReportPage {
        label: page.label,
        old: file("old", page.old)?,
        new: file("new", page.new)?,
        anchor: page.anchor.and_then(|a| placed(a, at, shown, notes)),
    })
}

/// `anchor` when the snapshot shows its path on its side and its lines are in order, else a note.
fn placed(
    anchor: ReportAnchor,
    at: &str,
    shown: &impl Fn(&str, Side) -> bool,
    notes: &mut Vec<String>,
) -> Option<ReportAnchor> {
    let side = anchor.side.unwrap_or(Side::New);
    let end = anchor.end_line.unwrap_or(anchor.line);
    let why = if anchor.line < 1 || end < anchor.line {
        Some("lines must be 1-based and in order".to_owned())
    } else if !shown(&anchor.path, side) {
        Some(format!("the review does not show {} on the {side} side", anchor.path))
    } else {
        None
    };
    match why {
        Some(why) => {
            notes.push(format!("{at}.anchor dropped: {why}"));
            None
        }
        None => Some(ReportAnchor { end_line: anchor.end_line.filter(|e| *e != anchor.line), ..anchor }),
    }
}

/// The first non-blank line of the first markdown block, bare of heading marks, cut to the summary length.
fn first_line(blocks: &[ReportBlock]) -> String {
    blocks
        .iter()
        .find_map(|b| match b {
            ReportBlock::Markdown { text, .. } => text.lines().map(str::trim).find(|l| !l.is_empty()),
            ReportBlock::Pages { .. } => None,
        })
        .map(|l| l.trim_start_matches('#').trim().chars().take(MAX_SUMMARY_CHARS).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::ReportBlockInput as B;

    fn input(blocks: Vec<B>) -> ReportInput {
        ReportInput { title: " Notes ".into(), summary: None, target: None, blocks }
    }

    fn anchor(path: &str, line: i64, end: Option<i64>) -> Option<ReportAnchor> {
        Some(ReportAnchor { path: path.into(), side: None, line, end_line: end })
    }

    #[test]
    fn resolves_files_and_drops_unplaceable_anchors() {
        let files = HashMap::from([("p/1.png".to_owned(), ReportFile { key: "k1".into(), type_: "image/png".into() })]);
        let shown = |path: &str, _: Side| path == "a.txt";
        let v = validate(
            input(vec![
                B::Markdown { text: "\n# Hello world\nmore".into(), anchor: anchor("a.txt", 3, Some(3)) },
                B::Markdown { text: "x".into(), anchor: anchor("gone.txt", 1, None) },
                B::Pages {
                    label: Some(" Rendered ".into()),
                    pages: vec![ReportPageInput {
                        label: "p. 1".into(),
                        old: None,
                        new: Some("p/1.png".into()),
                        anchor: anchor("a.txt", 0, None),
                    }],
                },
            ]),
            &files,
            shown,
        )
        .unwrap();
        assert_eq!((v.title.as_str(), v.summary.as_str()), ("Notes", "Hello world"));
        assert_eq!(v.notes.len(), 2, "{:?}", v.notes);
        let ReportBlock::Markdown { anchor: Some(a), .. } = &v.blocks[0] else { panic!("{:?}", v.blocks[0]) };
        assert_eq!((a.line, a.end_line), (3, None));
        let ReportBlock::Markdown { anchor: None, .. } = &v.blocks[1] else { panic!("{:?}", v.blocks[1]) };
        let ReportBlock::Pages { label, pages } = &v.blocks[2] else { panic!("{:?}", v.blocks[2]) };
        assert_eq!(label.as_deref(), Some("Rendered"));
        assert_eq!(pages[0].new.as_ref().unwrap().key, "k1");
        assert!(pages[0].anchor.is_none());
    }

    #[test]
    fn refuses_what_it_cannot_serve() {
        let files = HashMap::new();
        let shown = |_: &str, _: Side| true;
        let page = |path: &str| B::Pages {
            label: None,
            pages: vec![ReportPageInput { label: "p".into(), old: Some(path.into()), new: None, anchor: None }],
        };
        let cases: Vec<(ReportInput, &str)> = vec![
            (ReportInput { title: "  ".into(), summary: None, target: None, blocks: vec![] }, "title: required"),
            (input(vec![page("../x.png")]), "relative path"),
            (input(vec![page("x.png")]), "no file uploaded"),
            (input(vec![B::Markdown { text: "x".repeat(MAX_MARKDOWN_BYTES + 1), anchor: None }]), "at most"),
            (input(vec![B::Pages { label: None, pages: vec![] }; MAX_BLOCKS + 1]), "blocks: at most"),
        ];
        for (report, needle) in cases {
            let err = validate(report, &files, shown).unwrap_err().to_string();
            assert!(err.contains(needle), "{err}");
        }
        for id in ["ok-1", "a"] {
            check_id(id).unwrap();
        }
        for id in ["", "A", "-a", "a_b", &"a".repeat(65)] {
            assert!(check_id(id).is_err(), "{id}");
        }
        assert!(safe_relative("a/b.png") && !safe_relative("/a") && !safe_relative("a/../b") && !safe_relative("a\\b"));
    }
}
