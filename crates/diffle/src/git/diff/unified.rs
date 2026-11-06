//! Patches in `git diff`'s format: its headers, path quoting, hunk grouping and the `@@` function
//! context line, so what the viewer parses and shows is what git would print.
use gix::ObjectId;

use super::hunks;
use super::rename::MAX_SCORE;
use super::sides::{GITLINK, kind};

/// Git's `FIRST_FEW_BYTES`: a NUL this early makes a file binary.
const SNIFF: usize = 8000;

pub fn is_binary(buf: &[u8]) -> bool {
    buf[..buf.len().min(SNIFF)].contains(&0)
}

/// One side of a file pair as the header needs it.
pub struct Side<'a> {
    pub path: &'a [u8],
    pub mode: u32,
    pub id: ObjectId,
    pub short: String,
}

/// The pair's content: text to diff, or binary.
pub enum Body<'a> {
    Text(&'a [u8], &'a [u8]),
    Binary,
}

/// Appends one file pair's patch. A typechange is two patches, a deletion then an addition, as git splits it.
pub fn write(
    out: &mut Vec<u8>,
    (old, new): (Option<&Side>, Option<&Side>),
    rename: Option<u64>,
    body: Body,
    context: u32,
    abbrev: usize,
) {
    let (a, b) = (old.or(new).expect("a side"), new.or(old).expect("a side"));
    out.extend_from_slice(b"diff --git ");
    out.extend_from_slice(&quote_two(b"a/", a.path));
    out.push(b' ');
    out.extend_from_slice(&quote_two(b"b/", b.path));
    out.push(b'\n');
    match (old, new) {
        (None, Some(new)) => out.extend_from_slice(format!("new file mode {:06o}\n", new.mode).as_bytes()),
        (Some(old), None) => out.extend_from_slice(format!("deleted file mode {:06o}\n", old.mode).as_bytes()),
        (Some(old), Some(new)) => {
            if let Some(score) = rename {
                out.extend_from_slice(
                    format!("similarity index {}%\nrename from ", score * 100 / MAX_SCORE).as_bytes(),
                );
                out.extend_from_slice(&quote(old.path));
                out.extend_from_slice(b"\nrename to ");
                out.extend_from_slice(&quote(new.path));
                out.push(b'\n');
            }
            if old.mode != new.mode {
                out.extend_from_slice(format!("old mode {:06o}\nnew mode {:06o}\n", old.mode, new.mode).as_bytes());
            }
        }
        (None, None) => unreachable!("a side"),
    }
    let (old_id, new_id) = (old.map(|s| s.id), new.map(|s| s.id));
    if old_id != new_id {
        let short = |side: Option<&Side>| side.map_or_else(|| "0".repeat(abbrev), |s| s.short.clone());
        out.extend_from_slice(format!("index {}..{}", short(old), short(new)).as_bytes());
        if let (Some(old), Some(new)) = (old, new)
            && old.mode == new.mode
        {
            out.extend_from_slice(format!(" {:06o}", old.mode).as_bytes());
        }
        out.push(b'\n');
    }
    let label =
        |prefix: &[u8], side: Option<&Side>| side.map_or_else(|| b"/dev/null".to_vec(), |s| quote_two(prefix, s.path));
    let (old_label, new_label) = (label(b"a/", old), label(b"b/", new));
    match body {
        Body::Binary if old_id != new_id => {
            out.extend_from_slice(b"Binary files ");
            out.extend_from_slice(&old_label);
            out.extend_from_slice(b" and ");
            out.extend_from_slice(&new_label);
            out.extend_from_slice(b" differ\n");
        }
        Body::Binary => {}
        Body::Text(before, after) => {
            let hunks = hunks::hunks(before, after, context, true);
            if hunks.is_empty() {
                return;
            }
            // Git tabs a name with a space, so the line's end is unambiguous to `patch`.
            let tab = |side: Option<&Side>| if side.is_some_and(|s| s.path.contains(&b' ')) { &b"\t"[..] } else { b"" };
            out.extend_from_slice(b"--- ");
            out.extend_from_slice(&old_label);
            out.extend_from_slice(tab(old));
            out.extend_from_slice(b"\n+++ ");
            out.extend_from_slice(&new_label);
            out.extend_from_slice(tab(new));
            out.push(b'\n');
            for hunk in &hunks {
                out.extend_from_slice(hunk.header.as_bytes());
                if !hunk.func.is_empty() {
                    out.push(b' ');
                    out.extend_from_slice(&hunk.func);
                }
                out.push(b'\n');
                for &(prefix, line) in &hunk.lines {
                    emit(out, prefix, line);
                }
            }
        }
    }
}

/// Whether two modes hold different kinds of thing (file, link, submodule), which git patches as two.
pub fn splits(old: u32, new: u32) -> bool {
    kind(old) != kind(new) && !(kind(old) == GITLINK && kind(new) == GITLINK)
}

fn emit(out: &mut Vec<u8>, prefix: u8, line: &[u8]) {
    out.push(prefix);
    out.extend_from_slice(line);
    if line.last() != Some(&b'\n') {
        out.extend_from_slice(b"\n\\ No newline at end of file\n");
    }
}

/// `prefix` and `path` as git prints them together: in quotes, escaped, when the path needs it.
fn quote_two(prefix: &[u8], path: &[u8]) -> Vec<u8> {
    let mut joined = prefix.to_vec();
    joined.extend_from_slice(path);
    quote(&joined)
}

/// Git's C-style quoting with `core.quotePath=false`: control characters, `"` and `\` are escaped
/// and the whole name quoted; other bytes, UTF-8 included, pass through.
fn quote(name: &[u8]) -> Vec<u8> {
    if !name.iter().any(|&c| c < 0x20 || c == b'"' || c == b'\\' || c == 0x7f) {
        return name.to_vec();
    }
    let mut out = vec![b'"'];
    for &c in name {
        match c {
            0x07 => out.extend_from_slice(b"\\a"),
            0x08 => out.extend_from_slice(b"\\b"),
            b'\t' => out.extend_from_slice(b"\\t"),
            b'\n' => out.extend_from_slice(b"\\n"),
            0x0b => out.extend_from_slice(b"\\v"),
            0x0c => out.extend_from_slice(b"\\f"),
            b'\r' => out.extend_from_slice(b"\\r"),
            b'"' => out.extend_from_slice(b"\\\""),
            b'\\' => out.extend_from_slice(b"\\\\"),
            c if c < 0x20 || c == 0x7f => out.extend_from_slice(format!("\\{c:03o}").as_bytes()),
            c => out.push(c),
        }
    }
    out.push(b'"');
    out
}
