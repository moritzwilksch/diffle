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

A tour is one HTML document that walks the reviewer through the change. diffle lays its cards out
on a canvas, connected by the arrows you declare, and the reviewer steps through the numbered ones
with `n` and `p`. Each review has one tour.

- `diffle tour push [<file>|-]` checks the document (stdin without a file) and shows it in place
  of the review's tour, and prints the stored tour as JSON. A refused document exits 2 and lists
  every reason as `<element>: <reason>`; fix them all and push again.
- `diffle tour clear` removes the review's tour.
- The reviewer answers in this chat. Revise the document and push it again; the open tour updates
  in place. Cards whose lines left the review since are marked stale.

### Rules

- The order is part of the explanation. Number the cards the reviewer should read, `step=\"1\"`
  on, in the order that explains the change best; leave context cards without a step.
- Keep cards short: a title, a sentence or two, and one diff of at most about 12 lines. Split a
  long story into more steps.
- Cards sit at the top level or in a `diffle-group`; groups and edges sit at the top level; every
  other element sits inside a card.
- Close every `diffle-*` element with its end tag: HTML ignores `/>` on them.
- Paths are relative to the repository root and must be files of the review. Line numbers count on
  the side you name: `new`, the file after the change, by default.
- diffle styles the tour: no `style`, `class`, scripts or images.
- A `diffle-symbol` lists its references through the language server for its file. Without one,
  or on the `old` side, it renders as plain code. Run `diffle lsp` to see which languages have a
  server before you rely on symbol chips.
";

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
</diffle-group>
<diffle-edge from="token" to="login" label="checked by"></diffle-edge>"#;

/// The agent interface as Markdown.
pub fn render() -> String {
    let contract: Value = serde_json::from_str(CONTRACT).expect("the embedded contract is JSON");
    let defs = &contract["$defs"];
    let mut out = String::from(INTRO);
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
}
