//! A `diffle-code` block: what its attributes may combine, and whether the parser cut one short.
use super::dom::{Dom, Node, NodeId};

/// Whether a `diffle-code` under `node` holds markup: a raw `<` the parser read as a tag, which may
/// have cut the block short and moved what follows into or beside it.
pub fn holds_markup(dom: &Dom, node: NodeId) -> bool {
    dom.children(node).iter().any(|&c| match dom.node(c) {
        Node::Element { name, .. } if &*name.local == "diffle-code" => {
            dom.children(c).iter().any(|&g| matches!(dom.node(g), Node::Element { .. }))
        }
        Node::Element { .. } => holds_markup(dom, c),
        _ => false,
    })
}

/// Why a `diffle-code` with `attrs` is refused: attributes that do not go together.
pub fn refusals(attrs: &[(String, String)]) -> Vec<&'static str> {
    let has = |name: &str| attrs.iter().any(|(key, _)| key == name);
    let mut found = Vec::new();
    if has("example") && (has("path") || has("line")) {
        found.push("an example is made up, not from a file: it takes no path or line");
    } else if has("line") && !has("path") {
        found.push("line counts in a path: give diffle-code its path");
    }
    if !has("path") && !has("lang") {
        found.push("diffle-code takes lang when it has no path to name it");
    }
    if has("title") && !has("example") {
        found.push("title names an example: add example, or drop title");
    }
    found
}

/// How a `diffle-code` lays out, measured in the tour at its widest; change these with the client.
/// The article's column, in pixels: `PAGE_WIDTH` in `TourPage.tsx`.
const COLUMN: f64 = 920.0;
/// Between a row's columns: `.tour-row`'s `gap` in `tour.css`.
const ROW_GAP: f64 = 24.0;
/// The block's 1px border on each side (`Code.tsx`).
const FRAME: f64 = 2.0;
/// One character of the rows' monospace: `@pierre/diffs`' 13px default at 0.6em.
const ADVANCE: f64 = 7.8;
/// The gutter: 4ch of line numbers and the library's 2px gap; unnumbered, its 6px stub.
const NUMBERED_GUTTER: f64 = 4.0 * ADVANCE + 2.0;
const BARE_GUTTER: f64 = 6.0;
/// A row's padding in characters: 2 before (the diff's +/- indicator column) and 1 after.
const PADDING: usize = 3;
/// A tab's width in characters: the library's `tab-size`.
const TAB: usize = 2;
/// One rem at the default text size: `html`'s 90% of 16px in `base.css`.
const REM: f64 = 14.4;

/// A box a `diffle-code` can sit in, narrower than the column by its border and padding.
#[derive(Clone, Copy)]
pub enum Frame {
    /// `.tour-card`'s border and `.tour-card-body`'s 1rem padding (`tour.css`).
    Card,
    /// `.tour-tabs`' border and `.tour-tab-pane`'s 1rem padding (`panes.css`).
    Tab,
    /// `details`' border and 0.875rem inline padding (`panes.css`).
    Details,
}

impl Frame {
    fn inset(self) -> f64 {
        match self {
            Frame::Card | Frame::Tab => 2.0 * (1.0 + REM),
            Frame::Details => 2.0 * (1.0 + 0.875 * REM),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Frame::Card => "a diffle-card",
            Frame::Tab => "a diffle-tab",
            Frame::Details => "a <details>",
        }
    }
}

/// The characters a line of a `diffle-code` holds before it wraps, in one of a row's `columns`
/// (1 at full width) and inside `frames`; `numbered` when its gutter numbers the lines, as a block
/// without `path` does.
pub fn fits(columns: usize, frames: &[Frame], numbered: bool) -> usize {
    let columns = columns.max(1) as f64;
    let inset: f64 = frames.iter().map(|f| f.inset()).sum();
    let width = (COLUMN - ROW_GAP * (columns - 1.0)) / columns - inset;
    let gutter = if numbered { NUMBERED_GUTTER } else { BARE_GUTTER };
    ((width - FRAME - gutter) / ADVANCE).floor() as usize - PADDING
}

/// A warning for each line of `code` that wraps where it sits, as `fits` counts.
pub fn wraps(code: &str, columns: usize, frames: &[Frame], numbered: bool) -> Vec<String> {
    let limit = fits(columns, frames, numbered);
    let place = match (frames.last(), columns) {
        (Some(frame), _) => format!("inside {}", frame.name()),
        (None, 2..) => format!("in a column of a {columns}-column row"),
        (None, _) => "at full width".into(),
    };
    dedent(code)
        .iter()
        .enumerate()
        .filter_map(|(i, line)| {
            let width: usize = line.chars().map(|c| if c == '\t' { TAB } else { 1 }).sum();
            (width > limit).then(|| {
                format!(
                    "Line {} wraps, at {width} characters: {limit} fit {place}. Break it as the language's formatter would, one parameter per line",
                    i + 1
                )
            })
        })
        .collect()
}

/// The lines of `code` as the block shows them: without the blank lines around them and the
/// indentation they share (`dedent` in `Code.tsx`).
fn dedent(code: &str) -> Vec<&str> {
    let lines: Vec<&str> = code.lines().map(str::trim_end).collect();
    let Some(first) = lines.iter().position(|l| !l.trim().is_empty()) else { return Vec::new() };
    let last = lines.iter().rposition(|l| !l.trim().is_empty()).unwrap_or(first);
    let body = &lines[first..=last];
    let indent =
        body.iter().filter(|l| !l.trim().is_empty()).map(|l| l.len() - l.trim_start().len()).min().unwrap_or(0);
    body.iter().map(|l| l.get(indent..).unwrap_or("")).collect()
}

#[cfg(test)]
mod tests {
    use super::{Frame, fits};
    use crate::tour::validate::outline;

    fn warnings(html: &str) -> Vec<String> {
        outline(html).warnings.into_iter().map(|(_, w)| w.message).collect()
    }

    fn code(len: usize) -> String {
        format!(r#"<diffle-code lang="rust">  {}</diffle-code>"#, "x".repeat(len))
    }

    #[test]
    fn fits_the_measured_layout() {
        assert_eq!([fits(1, &[], true), fits(2, &[], true), fits(3, &[], true)], [110, 49, 29]);
        assert_eq!([fits(1, &[], false), fits(2, &[], false), fits(3, &[], false)], [113, 53, 33]);
        assert_eq!([fits(1, &[Frame::Card], true), fits(1, &[Frame::Tab], true)], [106, 106]);
        assert_eq!([fits(1, &[Frame::Details], true), fits(1, &[Frame::Details], false)], [106, 110]);
    }

    #[test]
    fn counts_the_box_a_block_sits_in() {
        let tab = |len: usize| {
            warnings(&format!(
                r#"<h2>A</h2><diffle-tabs><diffle-tab title="A">{}</diffle-tab><diffle-tab title="B"><p>b</p></diffle-tab></diffle-tabs>"#,
                code(len)
            ))
        };
        assert!(tab(106).is_empty());
        assert_eq!(
            tab(107),
            [
                "Line 1 wraps, at 107 characters: 106 fit inside a diffle-tab. Break it as the language's formatter would, one parameter per line"
            ]
        );
        let details = |len: usize| warnings(&format!("<h2>A</h2><details><summary>S</summary>{}</details>", code(len)));
        assert!(details(106).is_empty());
        assert_eq!(details(107).len(), 1);
    }

    #[test]
    fn warns_of_a_line_past_what_fits_at_its_place() {
        for len in [109, 110] {
            assert_eq!(warnings(&format!("<h2>A</h2>{}", code(len))), Vec::<String>::new());
        }
        assert_eq!(
            warnings(&format!("<h2>A</h2>{}", code(111))),
            [
                "Line 1 wraps, at 111 characters: 110 fit at full width. Break it as the language's formatter would, one parameter per line"
            ]
        );
        let row = |len: usize| warnings(&format!("<h2>A</h2><diffle-row>{}{}</diffle-row>", code(len), code(1)));
        assert!(row(48).is_empty() && row(49).is_empty());
        assert_eq!(
            row(50),
            [
                "Line 1 wraps, at 50 characters: 49 fit in a column of a 2-column row. Break it as the language's formatter would, one parameter per line"
            ]
        );
        let path = r#"<h2>A</h2><diffle-row><diffle-code path="a.rs" line="1">x</diffle-code><diffle-code lang="rust">x</diffle-code><diffle-code path="a.rs" line="1">"#;
        assert_eq!(warnings(&format!("{path}{}</diffle-code></diffle-row>", "y".repeat(33))), Vec::<String>::new());
        assert_eq!(warnings(&format!("{path}{}</diffle-code></diffle-row>", "y".repeat(34))).len(), 1);
    }
}
