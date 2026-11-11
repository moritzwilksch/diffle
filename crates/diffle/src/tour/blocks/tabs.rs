//! A `diffle-tabs`: two to four panes shown one at a time, each a `diffle-tab` with its title.
use crate::tour::code::holds_markup;
use crate::tour::dom::{Dom, Node, NodeId};
use crate::tour::element::{Findings, label, short};

/// Why a `diffle-tab` without a title is refused, in place of the catalog's "missing field".
pub const UNTITLED: &str = "a diffle-tab takes a title: what its pane shows, in a few words";

/// The tabs of the `diffle-tabs` at `node`; what else it holds `check` refuses.
pub fn panes(dom: &Dom, node: NodeId) -> Vec<NodeId> {
    dom.children(node).iter().copied().filter(|&c| is_tab(dom, c)).collect()
}

/// Why the `diffle-tabs` at `node`, named `element`, is refused: content other than tabs, or a
/// count of tabs outside two to four.
pub fn check(dom: &Dom, node: NodeId, element: &str) -> Findings {
    // A code block the parser cut short moved what follows; its own refusal names the cause.
    if holds_markup(dom, node) {
        return Default::default();
    }
    let mut found = Findings::default();
    for &child in dom.children(node) {
        match dom.node(child) {
            Node::Text(text) if !text.trim().is_empty() => {
                let name = format!("{element} > text \"{}\"", short(text.trim()));
                found.error(child, name, "a diffle-tabs holds only its diffle-tab panes: text belongs in a tab");
            }
            Node::Element { name, attrs } if &*name.local != "diffle-tab" => {
                let name = format!("{element} > {}", label(&name.local, attrs));
                let message =
                    "a diffle-tabs holds only its diffle-tab panes: prose goes in a tab, or before or after it";
                found.error(child, name, message);
            }
            _ => {}
        }
    }
    let count = panes(dom, node).len();
    if !(2..=4).contains(&count) {
        found.error(node, element.into(), format!("a diffle-tabs holds two to four diffle-tab panes, not {count}"));
    }
    found
}

fn is_tab(dom: &Dom, id: NodeId) -> bool {
    matches!(dom.node(id), Node::Element { name, .. } if &*name.local == "diffle-tab")
}

#[cfg(test)]
mod tests {
    #[test]
    fn leaves_a_code_block_cut_short_to_its_own_refusal() {
        let html = r#"<h2>A</h2><diffle-tabs><diffle-tab title="A"><diffle-code lang="rust">a<p>b</diffle-code></diffle-tab><diffle-tab title="B"><p>b</p></diffle-tab></diffle-tabs>"#;

        let messages: Vec<String> = crate::tour::outline_errors(html).into_iter().map(|e| e.message).collect();

        assert_eq!(messages, ["diffle-code holds its code as text: write < as &lt; and & as &amp;"]);
    }
}
