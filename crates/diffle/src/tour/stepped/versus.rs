//! A `diffle-versus`: two runs of one input, step for step. A step both runs take is a sentence; a
//! step where they differ holds each run's own, and a run that has ended takes no more steps.
use super::{Findings, MANY, sentence};
use crate::tour::code::holds_markup;
use crate::tour::dom::{Dom, Node, NodeId};
use crate::tour::element::{attr, label, short};

/// Checks the versus at `node`, named `element`; each place is checked as a reference.
pub fn check(dom: &Dom, node: NodeId, element: &str) -> Findings {
    let mut found = Findings::default();
    // A code block the parser cut short moved what follows; its own refusal names the cause.
    if holds_markup(dom, node) {
        return found;
    }
    let mut steps = 0;
    let mut split = false;
    // The step at which each run, old and new, ended.
    let mut ended: [Option<usize>; 2] = [None, None];
    for &child in dom.children(node) {
        match dom.node(child) {
            Node::Text(text) if !text.trim().is_empty() => {
                let name = format!("{element} > text \"{}\"", short(text.trim()));
                found.error(child, name, "a diffle-versus holds only diffle-steps: text belongs in a step");
            }
            Node::Element { name, attrs } if &*name.local == "diffle-step" => {
                steps += 1;
                let name = format!("{element} > {}", label("diffle-step", attrs));
                let runs = runs(dom, child);
                if runs.is_empty() {
                    paired(attrs, &name, child, &mut found);
                    sentence(dom, child, &name, "step", &mut found);
                    if let Some(at) = ended.iter().flatten().min() {
                        let message = format!("a run ended at step {at}: later steps hold only the other run's");
                        found.error(child, name, message);
                    }
                    continue;
                }
                split = true;
                one_step(dom, child, &name, attrs, &runs, &mut found);
                for (run, tag) in [(0, "diffle-before"), (1, "diffle-after")] {
                    let has = runs.iter().any(|&(_, t)| t == tag);
                    if let (true, Some(at)) = (has, ended[run]) {
                        let message =
                            format!("the {} run ended at step {at}: it takes no later step", ["old", "new"][run]);
                        found.error(child, name.clone(), message);
                    }
                    if !has && ended[run].is_none() {
                        ended[run] = Some(steps);
                    }
                }
            }
            Node::Element { name, attrs } => {
                let name = format!("{element} > {}", label(&name.local, attrs));
                found.error(child, name, "a diffle-versus holds only diffle-steps: prose goes before or after it");
            }
            _ => {}
        }
    }
    if steps < 2 {
        let message = "a diffle-versus holds two or more diffle-steps: one per step both runs take, in order";
        found.error(node, element.into(), message);
    } else if !split {
        let message = "its runs never differ: give the step where they part a diffle-before and a diffle-after, or follow one run with a diffle-trace";
        found.error(node, element.into(), message);
    }
    if steps > MANY {
        let message = format!(
            "Has {steps} steps; past about {MANY} a versus is hard to follow: keep the steps the runs differ at"
        );
        found.warn(node, element.into(), message);
    }
    found
}

/// The runs' steps a step holds: its `diffle-before` and `diffle-after` elements, in order.
fn runs(dom: &Dom, step: NodeId) -> Vec<(NodeId, &str)> {
    let run = |&c: &NodeId| match dom.node(c) {
        Node::Element { name, .. } if matches!(&*name.local, "diffle-before" | "diffle-after") => {
            Some((c, if &*name.local == "diffle-before" { "diffle-before" } else { "diffle-after" }))
        }
        _ => None,
    };
    dom.children(step).iter().filter_map(run).collect()
}

/// Checks a step where the runs differ: no place of its own, nothing but one before and one after, in that order.
fn one_step(
    dom: &Dom,
    node: NodeId,
    name: &str,
    attrs: &[(String, String)],
    runs: &[(NodeId, &str)],
    found: &mut Findings,
) {
    if ["path", "line", "side"].iter().any(|key| attr(attrs, key).is_some()) {
        let message = "a step where the runs differ takes no place: its diffle-before and diffle-after name theirs";
        found.error(node, name.into(), message);
    }
    let stray = dom.children(node).iter().any(|&c| match dom.node(c) {
        Node::Text(text) => !text.trim().is_empty(),
        Node::Element { name, .. } => !matches!(&*name.local, "diffle-before" | "diffle-after"),
        _ => false,
    });
    let tags: Vec<&str> = runs.iter().map(|&(_, t)| t).collect();
    if stray || !matches!(tags.as_slice(), ["diffle-before"] | ["diffle-after"] | ["diffle-before", "diffle-after"]) {
        let message = "a step where the runs differ holds one diffle-before, then one diffle-after, and nothing else";
        found.error(node, name.into(), message);
    }
    for &(run, tag) in runs {
        let Node::Element { attrs, .. } = dom.node(run) else { continue };
        let run_name = format!("{name} > {}", label(tag, attrs));
        paired(attrs, &run_name, run, found);
        sentence(dom, run, &run_name, "run's step", found);
    }
}

/// Refuses a place half given: `path` without `line`, or `line` without `path`.
fn paired(attrs: &[(String, String)], name: &str, node: NodeId, found: &mut Findings) {
    if attr(attrs, "path").is_some() != attr(attrs, "line").is_some() {
        found.error(node, name.into(), "a place takes path and line together");
    }
}
