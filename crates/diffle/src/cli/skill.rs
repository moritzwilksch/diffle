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

A tour is one HTML document that walks the reviewer through the change, read as an article: an
optional `<h1>` title, then sections. Each `<h2>` starts a section, and the sections are the steps
of the walk: the reviewer moves between them with `n` and `p`, and the side panel lists them with
their `<h3>` subsections. Each review has one tour.

- `diffle tour push [<file>|-]` checks the document (stdin without a file) and shows it in place
  of the review's tour, and prints the stored tour as JSON. A refused document exits 2, lists
  every reason as `<element>: <reason>`, and leaves the previous tour in place; fix them all and
  push again.
- An accepted push can come back with warnings on stderr, in the same form, such as a diagram
  label that may run past its box. They are judgment calls: fix each, or keep it knowingly.
- `diffle tour clear` removes the review's tour.
- The reviewer answers in this chat. Revise the document and push it again; the open tour updates
  in place. A diff whose lines left the review since says so in place.

### Structure

- The order is part of the explanation. Give each step of the walk an `<h2>`, in the order that
  explains the change best, and use `<h3>` for parts of a long section. Headings sit at the top
  level of the document.
- Between headings, write prose and lists, and place blocks: a `diffle-card`, a `diffle-diff`, a
  `diffle-diagram`, a table, a `diffle-tree`, a `diffle-callout`. A block sits between paragraphs,
  never inside one.
- Use a `diffle-card` to explain one part of the diff next to its code: a title, a sentence or
  two, and its `diffle-diff`s. Use plain prose and the other blocks for the rest. No card goes
  inside another, and a heading never goes inside a card.
- Put two or three blocks or short prose columns side by side in a `diffle-row` when they belong
  together: a table beside the prose about it, or two small diagrams to compare. Each column is a
  block, or prose in a `<div>`, `<p>`, `<ul>` or `<ol>`, and a row sits at the top level. Keep
  diffs and cards with diffs full width: in a row their lines may wrap. A narrow window stacks a
  row's columns.
- Keep a diff to at most about 12 lines, and split a long story into more sections.
- Use a `diffle-callout` for what the reviewer should not miss; it holds prose, not headings.
- Close every `diffle-*` element with its end tag: HTML ignores `/>` on them.
- Paths are relative to the repository root and must be files of the review. Line numbers count on
  the side you name: `new`, the file after the change, by default.
- diffle styles the tour: no `style`, scripts or images, and `class` only inside a diagram.
- Mark every code symbol your prose names with a `diffle-symbol` when it has a line in the review
  to point at: the reviewer sees it coloured as in the diff, hovers it for its signature, and
  clicks it for its references. Keep `<code>` for what is not a symbol: paths, commands, literals.
- Hover and references need the language server for the symbol's file, and the `new` side. Without
  them the chip is coloured code only. Run `diffle lsp` to see which languages have a server.

### Writing

The reviewer reads your words inside diffle, so hold them to its bar as a product. Write like a
senior colleague explaining the change across a table: lead with the point, use plain and exact
words, and keep sentences short and active. Name what the diff shows, such as names, numbers and
consequences, instead of adjectives. State only what the diff supports, and never invent a
rationale. Cut filler, stacked hedges, reflexive triads, windups such as \"Here's the thing:\",
and closing summaries. Skip stock phrasing such as \"delve\", \"robust\", \"seamless\",
\"crucial\", \"leverage\" and \"it's worth noting\". Use straight quotes, no em dashes, and
no emoji. A section opens with a sentence or two on what it shows; a card is its title and one or
two sentences. Let the diff show the code.

### Diagrams and tables

Draw a `diffle-diagram` to show how parts connect; use a table to compare options or map one thing
to another. Put its caption in the prose before it. A table is plain HTML:
`table`, `thead`, `tbody`, `tr`, `th` and `td`, with `colspan` and `rowspan` on a cell.

A diagram holds one `<svg viewBox=\"0 0 <width> <height>\">` that you draw by hand; one unit is
one pixel. diffle styles it from the classes below and the theme, and draws the arrowheads, so
write no `style`, `fill`, `stroke`, font or marker attributes and no `<defs>`.

- Make one point per diagram, and draw only the parts it needs. It shows at its own width and
  never larger; keep it 1400 wide or less, the page at its widest, or a row's column width, or it
  shrinks, text and all.
- Place parts on a grid: snap to 8, keep one column and row pitch, and give the boxes in a row the
  same height and gaps.
- Text is centred vertically on its `y`, not set on a baseline. Lay out a node from its corner
  (x, y): a lone name at (x+12, y+20) in a box 40 tall, the box's middle; with a detail line at
  (x+12, y+40), the box is 56 tall. Make the box 24 wide plus about 9 per character of its longest
  line (10 in `mono`, 8 in `small`), so 12 units of padding stay on each side. Keep names to three
  words or fewer, in sentence case, without a period.
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
<diffle-tree root="src" paths="src/auth.rs
src/login.rs"></diffle-tree>
<p>The old check is gone: <diffle-jump path="src/auth.rs" line="30" side="old">see what it did</diffle-jump>.</p>"#;

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
        let card = format!("<h2>A</h2>{}", super::DIAGRAM);
        let errors = crate::tour::outline_errors(&card);
        assert!(errors.is_empty(), "{:?}", errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    }
}
