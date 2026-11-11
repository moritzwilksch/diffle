//! `diffle --skill`: everything diffle offers a coding agent, as Markdown without frontmatter, for
//! the user to install as a skill under a name and description of their own. The element catalog
//! comes from the contract the validator enforces, so the two never disagree.
use std::fmt::Write as _;

use serde_json::Value;

/// The wire contract, which carries the catalog's schemas and their documentation.
const CONTRACT: &str = include_str!("../../protocol.generated.json");

const INTRO: &str = "\
# diffle

diffle is the reviewer's diff viewer, running in the browser beside you. The commands below talk
to the diffle serving the repository you are in, or the one `-C <path>` names: a run announces
itself in `<git-dir>/diffle/server.json`. Without a run they exit 2 with \"no diffle is running for
this repository\"; ask the reviewer to start one (`diffle` in the repository).

## Read the review's comments

`diffle comments list [--state open|resolved|all] [--path <path>]` prints the threads the reviewer
is shown as one JSON document: `commentKey`, the set they belong to, and `threads`, each with its
anchor (a path and a line range on the `old` or `new` side, or a whole file) and its messages.

## Give the reviewer a tour

A tour is one HTML document that walks the reviewer through the change. diffle shows it as one
scrolling page: the numbered cards in step order, then the rest in document order, and each
`diffle-group` as a titled section around its cards. The reviewer steps through the numbered cards
with `n` and `p`. Each review has one tour.

- `diffle tour push [<file>|-]` checks the document (stdin without a file) and shows it in place
  of the review's tour, and prints the stored tour as JSON. A refused document exits 2, lists
  every reason as `<element>: <reason>`, and leaves the previous tour in place; fix them all and
  push again.
- `diffle tour clear` removes the review's tour.
- The reviewer answers in this chat. Revise the document and push it again; the open tour updates
  in place. Cards whose lines left the review since are marked stale.

### Rules

- The order is part of the explanation. Number the cards the reviewer should read, `step=\"1\"`
  on, in the order that explains the change best; leave context cards without a step.
- Keep a card's diff to at most about 12 lines, and split a long story into more steps.
- Cards sit at the top level or in a `diffle-group`; groups sit at the top level; every other
  element sits inside a card.
- Keep a group's steps consecutive: the group shows as one section, at its first step.
- Nothing draws arrows between cards. Say how cards relate in their prose, or draw a diagram.
- Close every `diffle-*` element with its end tag: HTML ignores `/>` on them.
- Paths are relative to the repository root and must be files of the review. Line numbers count on
  the side you name: `new`, the file after the change, by default.
- diffle styles the tour: no `style`, scripts or images, and `class` only inside a diagram.
- A `diffle-symbol` lists its references through the language server for its file. Without one,
  or on the `old` side, it renders as plain code. Run `diffle lsp` to see which languages have a
  server before you rely on symbol chips.

### Writing

The reviewer reads your words inside diffle, so hold them to its bar as a product. Write like a
senior colleague explaining the change across a table: lead with the point, use plain and exact
words, and keep sentences short and active. Name what the diff shows, such as names, numbers and
consequences, instead of adjectives. State only what the diff supports, and never invent a
rationale. Cut filler, stacked hedges, reflexive triads, windups such as \"Here's the thing:\",
and closing summaries. Skip stock phrasing such as \"delve\", \"robust\", \"seamless\",
\"crucial\", \"leverage\" and \"it's worth noting\". Use straight quotes, no em dashes, and
no emoji. A card is its title and one or two sentences; let the diff show the code.

### Diagrams and tables

Draw a `diffle-diagram` to show how parts connect; use a table to compare options or map one thing
to another. Either sits inside a card, with its caption in the card's prose. A table is plain HTML:
`table`, `thead`, `tbody`, `tr`, `th` and `td`, with `colspan` and `rowspan` on a cell.

A diagram holds one `<svg viewBox=\"0 0 <width> <height>\">` that you draw by hand; one unit is
one pixel. diffle styles it from the classes below and the theme, and draws the arrowheads, so
write no `style`, `fill`, `stroke`, font or marker attributes and no `<defs>`.

- Make one point per diagram, and draw only the parts it needs. Keep it 960 wide or less.
- Place parts on a grid: snap to 8, keep one column and row pitch, and give the boxes in a row the
  same height and gaps.
- Lay out a node from its corner (x, y): its name at (x+12, y+20) in a box 40 tall, or with a
  detail line at (x+12, y+40) in a box 56 tall. Make it about 24 plus 9 per character wide. Keep
  names to three words or fewer, in sentence case, without a period.
- Put a box and its text in a `<g>`, so a tone on the group colors all of it.
- Keep one main direction of flow. Start and end each line at the middle of a box side, square to
  it, with at most two bends and no crossings. Put a line's label 16 above a horizontal line or 16
  right of a vertical one, never on it.
- Name a region with a `frame` rect and an `eyebrow` text at (x+16, y+20).
- Tone at most about a third of the nodes, and only those the point is about.
";

const DIAGRAM: &str = r#"<diffle-diagram><svg viewBox="0 0 560 88">
  <g><rect x="24" y="24" width="128" height="40"/><text x="36" y="44" class="bold">Login</text></g>
  <path d="M152 44 H216" class="arrow"/>
  <text x="184" y="28" class="c small">checks</text>
  <g class="accent"><rect x="216" y="24" width="128" height="40"/><text x="228" y="44" class="bold">Validate</text></g>
  <path d="M344 44 H408" class="arrow"/>
  <text x="376" y="28" class="c small">reads</text>
  <g><rect x="408" y="24" width="128" height="40"/><text x="420" y="44" class="bold">Token store</text></g>
</svg></diffle-diagram>"#;

const EXAMPLE: &str = r#"<diffle-card id="token" step="1" title="Tokens expire">
  <p>A token now carries its expiry, and <diffle-symbol path="src/auth.rs" line="12" name="validate"></diffle-symbol> rejects old ones.</p>
  <diffle-diff path="src/auth.rs" lines="10-18"></diffle-diff>
</diffle-card>
<diffle-group title="Callers">
  <diffle-card id="login" step="2" title="Login sets the expiry">
    <diffle-diff path="src/login.rs" lines="40-44"></diffle-diff>
    <diffle-callout kind="warning"><p>Sessions issued before the deploy expire at once.</p></diffle-callout>
  </diffle-card>
  <diffle-card id="layout" title="Where the auth code lives">
    <diffle-tree root="src" paths="src/auth.rs
src/login.rs"></diffle-tree>
    <p>The old check is gone: <diffle-jump path="src/auth.rs" line="30" side="old">see what it did</diffle-jump>.</p>
  </diffle-card>
</diffle-group>"#;

/// The agent interface as Markdown.
pub fn render() -> String {
    let contract: Value = serde_json::from_str(CONTRACT).expect("the embedded contract is JSON");
    let defs = &contract["$defs"];
    let mut out = String::from(INTRO);
    out.push_str("\n#### Diagram elements\n\nEach takes the attributes listed; `?` marks an optional one.\n\n");
    for element in defs["TourSvgElement"]["oneOf"].as_array().expect("TourSvgElement is a union") {
        let tag = element["properties"]["tag"]["const"].as_str().expect("each element names its tag");
        let required: Vec<&str> =
            element["required"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        let optional = element["properties"].as_object().into_iter().flatten().map(|(name, _)| name.as_str());
        let optional = optional.filter(|name| *name != "tag" && !required.contains(name));
        let attributes: Vec<String> = required
            .iter()
            .filter(|name| **name != "tag")
            .map(|name| format!("`{name}`"))
            .chain(optional.map(|name| format!("`{name}?`")))
            .collect();
        let _ = writeln!(out, "- `{tag}`: {}", attributes.join(", "));
    }
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
    fn the_diagram_example_is_one_the_validator_accepts() {
        let card = format!(r#"<diffle-card id="a" title="A">{}</diffle-card>"#, super::DIAGRAM);
        assert_eq!(crate::tour::outline_errors(&card), []);
    }
}
