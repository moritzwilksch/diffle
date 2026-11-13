//! `diffle --skill`: everything diffle offers a coding agent, as Markdown without frontmatter, for
//! the user to install as a skill under a name and description of their own. The element catalog
//! comes from the contract the validator enforces, so the two never disagree.
use std::fmt::Write as _;

use serde_json::Value;

const INTRO: &str = include_str!("skill.md");

const DIAGRAM: &str = r#"<diffle-diagram><svg viewBox="0 0 360 52">
  <g><rect x="8" y="16" width="88" height="28"/><text x="16" y="30">Login</text></g>
  <path d="M96 30 H136" class="arrow"/>
  <text x="116" y="20" class="c small">checks</text>
  <g class="accent"><rect x="136" y="16" width="88" height="28"/><text x="144" y="30">Validate</text></g>
  <path d="M224 30 H264" class="arrow"/>
  <text x="244" y="20" class="c small">reads</text>
  <g><rect x="264" y="16" width="88" height="28"/><text x="272" y="30">Token store</text></g>
</svg></diffle-diagram>"#;

const EXAMPLE: &str = r#"<h1>Tokens expire</h1>
<p>A token now carries its expiry, and every check rejects an old one.</p>

<h2>Validation rejects old tokens</h2>
<p><diffle-symbol path="src/auth.rs" line="12" name="validate"></diffle-symbol> compares the expiry with the clock.</p>
<diffle-card id="expiry" title="The token carries its expiry">
  <p>Issuing sets it one hour ahead.</p>
  <diffle-diff path="src/auth.rs" lines="10-18"></diffle-diff>
</diffle-card>

<h2>Login sets the expiry</h2>
<diffle-diff path="src/login.rs" lines="40-44"></diffle-diff>
<diffle-callout kind="warning"><p>Sessions issued before the deploy expire at once.</p></diffle-callout>
<h3>Where the auth code lives</h3>
<diffle-tree title="Auth · Rust" root="src" paths="src/auth.rs
src/login.rs"><diffle-file path="src/auth.rs">start here</diffle-file></diffle-tree>
<p>The old check is gone: <diffle-jump path="src/auth.rs" line="30" side="old">see what it did</diffle-jump>.</p>"#;

/// The agent interface as Markdown.
pub fn render() -> String {
    let defs = &crate::protocol::contract()["$defs"];
    let mut out = String::from(INTRO);
    out.push_str("\n#### Diagram elements\n\nEach takes the attributes listed; `?` marks an optional one.\n\n");
    for element in defs["TourSvgElement"]["oneOf"].as_array().expect("TourSvgElement is a union") {
        let tag = element["properties"]["tag"]["const"].as_str().expect("each element names its tag");
        let _ = writeln!(out, "- `{tag}`: {}", attributes(element));
    }
    let _ = writeln!(out, "- `svg` inside the drawing, an icon: {}", attributes(&defs["TourSvgIcon"]));
    let _ = write!(
        out,
        "\n#### Diagram classes\n\n{}\n\n#### Diagram example\n\n```html\n{DIAGRAM}\n```\n",
        one_line(&defs["TourSvgClass"]["description"])
    );
    out.push_str("\n### Elements\n");
    for element in defs["TourElement"]["oneOf"].as_array().expect("TourElement is a union") {
        let tag = element["properties"]["tag"]["const"].as_str().expect("each element names its tag");
        let required: Vec<&str> =
            element["required"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        let _ = write!(out, "\n#### `{tag}`\n\n{}\n", one_line(&element["description"]));
        // The required attributes in the order the schema declares them, then the optional ones.
        let mut attributes: Vec<_> =
            element["properties"].as_object().into_iter().flatten().filter(|(name, _)| *name != "tag").collect();
        attributes.sort_by_key(|(name, _)| required.iter().position(|r| r == name).unwrap_or(usize::MAX));
        if attributes.is_empty() {
            continue;
        }
        out.push_str("\n| Attribute | Required | Meaning |\n|---|---|---|\n");
        for (name, attribute) in attributes {
            let needed = if required.contains(&name.as_str()) { "yes" } else { "no" };
            let _ = writeln!(out, "| `{name}` | {needed} | {} |", one_line(&attribute["description"]));
        }
    }
    let tags: Vec<String> = defs["TourTag"]["enum"]
        .as_array()
        .expect("TourTag is an enum")
        .iter()
        .filter_map(|t| t.as_str().map(|t| format!("`{t}`")))
        .collect();
    let _ = write!(
        out,
        "\n### Plain tags\n\n{} {}\n\n### Example\n\n```html\n{EXAMPLE}\n```\n",
        one_line(&defs["TourTag"]["description"]),
        tags.join(", "),
    );
    out
}

/// A diagram element's attributes, required first, the optional ones marked `?`.
fn attributes(element: &Value) -> String {
    let required: Vec<&str> = element["required"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    let optional = element["properties"].as_object().into_iter().flatten().map(|(name, _)| name.as_str());
    let optional = optional.filter(|name| *name != "tag" && !required.contains(name));
    let attributes: Vec<String> = required
        .iter()
        .filter(|name| **name != "tag")
        .map(|name| format!("`{name}`"))
        .chain(optional.map(|name| format!("`{name}?`")))
        .collect();
    attributes.join(", ")
}

/// A description on one line, as a table cell needs it.
fn one_line(description: &Value) -> String {
    description.as_str().unwrap_or_default().split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_example_is_a_tour_the_validator_accepts_apart_from_its_files() {
        assert!(crate::tour::outline_errors(super::EXAMPLE).is_empty());
    }

    #[test]
    fn the_interface_examples_are_ones_the_validator_accepts() {
        let blocks: Vec<&str> =
            super::INTRO.split("```html\n").skip(1).map(|b| b.split("```").next().unwrap()).collect();
        assert_eq!(blocks.len(), 4);
        let diagram =
            |b: &str| format!("<h2>A</h2><diffle-diagram><svg viewBox=\"0 0 280 60\">{b}</svg></diffle-diagram>");
        let whole = |b: &str| format!("<h2>A</h2>{b}");
        // One block is part of a drawing; the others are whole blocks.
        let documents = blocks.iter().map(|b| if b.starts_with("<rect") { diagram(b) } else { whole(b) });
        for html in documents {
            let found = [crate::tour::outline_errors(&html), crate::tour::outline_warnings(&html)].concat();
            let messages: Vec<_> = found.iter().map(|e| &e.message).collect();
            assert!(messages.is_empty(), "{messages:?}");
        }
    }

    #[test]
    fn the_diagram_example_is_one_the_validator_accepts() {
        let card = format!("<h2>A</h2>{}", super::DIAGRAM);
        let errors = crate::tour::outline_errors(&card);
        assert!(errors.is_empty(), "{:?}", errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    }
}
