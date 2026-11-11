//! A `diffle-tree`'s notes: a few words beside a few of its files, on where to start or what
//! surprises.
use crate::protocol::TourElement;
use crate::tour::anchor::reading;
use crate::tour::dom::{Dom, Node, NodeId};
use crate::tour::element::{Findings, label, short};

/// Past this many noted files, or a third of the tree, the notes stop standing out.
const MANY: usize = 3;
/// Past this many words a note says more than where to start or what surprises.
const LONG: usize = 6;

/// The notes of the tree at `node`; what else it holds `check` refuses.
pub fn files(dom: &Dom, node: NodeId) -> Vec<NodeId> {
    dom.children(node).iter().copied().filter(|&c| file_path(dom, c).is_some()).collect()
}

/// What is wrong with the notes of the tree at `node`, named `element`, as the catalog read it.
pub fn check(dom: &Dom, node: NodeId, element: &str, parsed: Option<&TourElement>) -> Findings {
    let mut found = Findings::default();
    let paths: Vec<&str> = match parsed {
        Some(TourElement::DiffleTree { paths, .. }) => paths.lines().map(str::trim).filter(|p| !p.is_empty()).collect(),
        _ => Vec::new(),
    };
    let mut noted: Vec<&str> = Vec::new();
    for &child in dom.children(node) {
        match (dom.node(child), file_path(dom, child)) {
            (Node::Text(text), _) if !text.trim().is_empty() => {
                let name = format!("{element} > text \"{}\"", short(text.trim()));
                found.error(child, name, "a diffle-tree holds only diffle-file notes: text belongs in a note");
            }
            (Node::Element { name, attrs }, None) => {
                let name = format!("{element} > {}", label(&name.local, attrs));
                let message = "a diffle-tree holds only diffle-file notes: close it with </diffle-tree> (HTML ignores />), and put prose before or after it";
                found.error(child, name, message);
            }
            (Node::Element { attrs, .. }, Some(path)) => {
                let name = format!("{element} > {}", label("diffle-file", attrs));
                let words = reading(dom, child).split_whitespace().count();
                if words == 0 {
                    found.error(
                        child,
                        name,
                        "a diffle-file holds its note: a few words on where to start or what surprises",
                    );
                } else if !paths.is_empty() && !paths.contains(&path) {
                    found.error(
                        child,
                        name,
                        format!("{path} is not one of the tree's paths: a note sits beside a file it lists"),
                    );
                } else if noted.contains(&path) {
                    found.error(child, name, format!("{path} has a note already: one note per file"));
                } else if words > LONG {
                    let message = format!(
                        "May be long for a file note, at {words} words: a few say where to start or what surprises"
                    );
                    found.warn(child, name, message);
                }
                noted.push(path);
            }
            _ => {}
        }
    }
    let (notes, all) = (noted.len(), paths.len());
    // A lone note crowds no tree.
    if notes > MANY || (notes > 1 && notes * 3 > all) {
        let message =
            format!("Notes {notes} of {all} files: note only where to start or what surprises, {MANY} files at most");
        found.warn(node, element.into(), message);
    }
    found
}

/// The `path` of a `diffle-file` at `id`; none for anything else.
fn file_path(dom: &Dom, id: NodeId) -> Option<&str> {
    match dom.node(id) {
        Node::Element { name, attrs } if &*name.local == "diffle-file" => {
            Some(attrs.iter().find(|(k, _)| k == "path").map_or("", |(_, v)| v.as_str()))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use crate::tour::validate::outline;

    fn warnings(notes: usize, files: usize) -> Vec<String> {
        let paths: Vec<String> = (0..files).map(|i| format!("f{i}.py")).collect();
        let notes: String =
            (0..notes).map(|i| format!(r#"<diffle-file path="f{i}.py">start here</diffle-file>"#)).collect();
        let html = format!(r#"<h2>A</h2><diffle-tree title="T" paths="{}">{notes}</diffle-tree>"#, paths.join("\n"));
        outline(&html).warnings.into_iter().map(|(_, w)| w.message).collect()
    }

    #[test]
    fn warns_when_notes_stop_being_sparse() {
        assert!(warnings(1, 2).is_empty());
        assert!(warnings(3, 9).is_empty());
        assert_eq!(warnings(2, 5), ["Notes 2 of 5 files: note only where to start or what surprises, 3 files at most"]);
        assert_eq!(warnings(4, 20).len(), 1);
    }
}
