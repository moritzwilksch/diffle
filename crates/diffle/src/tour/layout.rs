//! Warnings about a diagram's layout, checked from its geometry against the rules `--skill` gives:
//! a label inside its box and on its middle, boxes on the grid and inside the drawing, the canvas
//! width, and the share of toned shapes. What rests on the per-character estimate says "may"; a
//! geometric fact is said plainly.
use super::dom::{Dom, Node, NodeId};
use super::element::label;
use crate::protocol::TourError;

/// The widest a diagram should be, in units.
pub const MAX_WIDTH: f64 = 960.0;
const GRID: f64 = 8.0;
const TONES: [&str; 4] = ["accent", "success", "warning", "error"];

struct Rect {
    node: NodeId,
    element: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    frame: bool,
}

struct Label {
    node: NodeId,
    element: String,
    x: f64,
    y: f64,
    /// Its estimated extent, left to right, from its anchor and the per-character widths.
    left: f64,
    right: f64,
    eyebrow: bool,
}

#[derive(Default)]
struct Drawing {
    rects: Vec<Rect>,
    labels: Vec<Label>,
    /// Shapes that are nodes (not frames), and how many of them carry a tone.
    shapes: usize,
    toned: usize,
}

/// Every layout warning about the `diffle-diagram` at `node`, which warnings name as `element`.
pub fn warnings(dom: &Dom, node: NodeId, element: &str) -> Vec<(NodeId, TourError)> {
    let Some((svg, attrs)) = dom.children(node).iter().find_map(|&c| match dom.node(c) {
        Node::Element { name, attrs } if &*name.local == "svg" => Some((c, attrs)),
        _ => None,
    }) else {
        return Vec::new();
    };
    let view: Vec<f64> = get(attrs, "viewBox").split_whitespace().filter_map(|n| n.parse().ok()).collect();
    let [_, _, width, height] = view[..] else { return Vec::new() };
    let context = format!("{element} > ");
    let mut drawing = Drawing::default();
    for &child in dom.children(svg) {
        drawing.visit(dom, child, false, &context);
    }
    let mut found = Vec::new();
    let mut warn = |node: NodeId, element: &str, message: String| {
        found.push((node, TourError { element: element.into(), message }));
    };
    let svg_element = format!("{context}{}", label("svg", attrs));
    if width > MAX_WIDTH {
        warn(svg, &svg_element, format!("Is {} wide; keep a diagram {} wide or less", n(width), n(MAX_WIDTH)));
    }
    if drawing.shapes >= 3 && drawing.toned > drawing.shapes.div_ceil(3) {
        let message = format!(
            "Tones {} of {} shapes; tone about a third at most, only those the point is about",
            drawing.toned, drawing.shapes
        );
        warn(svg, &svg_element, message);
    }
    for rect in &drawing.rects {
        let off: Vec<String> = [("x", rect.x), ("y", rect.y), ("width", rect.w), ("height", rect.h)]
            .into_iter()
            .filter(|(_, v)| v % GRID != 0.0)
            .map(|(name, v)| format!("{name} {}", n(v)))
            .collect();
        if !off.is_empty() {
            warn(rect.node, &rect.element, format!("Is off the 8-unit grid: {}", off.join(", ")));
        }
        if rect.x < 0.0 || rect.y < 0.0 || rect.x + rect.w > width || rect.y + rect.h > height {
            let message = format!(
                "Runs past the drawing's edge: it spans {}-{} across and {}-{} down a {} by {} viewBox",
                n(rect.x),
                n(rect.x + rect.w),
                n(rect.y),
                n(rect.y + rect.h),
                n(width),
                n(height)
            );
            warn(rect.node, &rect.element, message);
        }
    }
    for text in &drawing.labels {
        let Some(home) = drawing.box_of(text) else {
            if text.left < 0.0 || text.right > width {
                let side = if text.left < 0.0 { "left" } else { "right" };
                warn(text.node, &text.element, format!("May run past the drawing's {side} edge"));
            }
            continue;
        };
        let wide = text.right - text.left;
        if wide > home.w {
            let message =
                format!("May be wider than its box: about {} wide in a {}-wide rect", n(wide.round()), n(home.w));
            warn(text.node, &text.element, message);
        } else if text.left < home.x || text.right > home.x + home.w {
            let (side, over) =
                if text.left < home.x { ("left", home.x - text.left) } else { ("right", text.right - home.x - home.w) };
            let message = format!("May run past its box's {side} edge, by about {}", n(over.round()));
            warn(text.node, &text.element, message);
        }
        let alone =
            drawing.labels.iter().filter(|l| !l.eyebrow && drawing.box_of(l).is_some_and(|b| b.node == home.node));
        let middle = home.y + home.h / 2.0;
        if !text.eyebrow && alone.count() == 1 && text.y != middle {
            let (side, by) = if text.y > middle { ("below", text.y - middle) } else { ("above", middle - text.y) };
            let message = format!(
                "Sits {} {side} its box's vertical middle: y is {}, the middle is {}; text centres on its y",
                n(by),
                n(text.y),
                n(middle)
            );
            warn(text.node, &text.element, message);
        }
    }
    found
}

impl Drawing {
    fn visit(&mut self, dom: &Dom, node: NodeId, toned: bool, context: &str) {
        let Node::Element { name, attrs } = dom.node(node) else { return };
        let tag = &*name.local;
        let classes: Vec<&str> = get(attrs, "class").split_whitespace().collect();
        let toned = toned || classes.iter().any(|c| TONES.contains(c));
        let element = format!("{context}{}", label(tag, attrs));
        let num = |key: &str| get(attrs, key).parse::<f64>().unwrap_or(0.0);
        let frame = classes.contains(&"frame");
        if matches!(tag, "rect" | "circle" | "ellipse" | "polygon") && !frame {
            self.shapes += 1;
            self.toned += usize::from(toned);
        }
        match tag {
            "rect" => {
                let (x, y, w, h) = (num("x"), num("y"), num("width"), num("height"));
                self.rects.push(Rect { node, element, x, y, w, h, frame });
            }
            "text" => {
                let wide = width(dom, node, &classes);
                let (x, y) = (num("x"), num("y"));
                let left = if classes.contains(&"c") {
                    x - wide / 2.0
                } else if classes.contains(&"e") {
                    x - wide
                } else {
                    x
                };
                let eyebrow = classes.contains(&"eyebrow");
                self.labels.push(Label { node, element, x, y, left, right: left + wide, eyebrow });
            }
            "g" => {
                for &child in dom.children(node) {
                    self.visit(dom, child, toned, context);
                }
            }
            _ => {}
        }
    }

    /// The smallest box, not a frame, whose area holds the label's anchor.
    fn box_of(&self, text: &Label) -> Option<&Rect> {
        let holds = |r: &&Rect| !r.frame && (r.x..=r.x + r.w).contains(&text.x) && (r.y..=r.y + r.h).contains(&text.y);
        self.rects.iter().filter(holds).min_by(|a, b| (a.w * a.h).total_cmp(&(b.w * b.h)))
    }
}

/// A label's width by the `--skill` estimate: per character 9 units, 10 in `mono`, 8 in `small`
/// and `eyebrow`; a `tspan` adds its own classes to its text's.
fn width(dom: &Dom, node: NodeId, classes: &[&str]) -> f64 {
    let per = if classes.iter().any(|c| matches!(*c, "small" | "eyebrow")) {
        8.0
    } else if classes.contains(&"mono") {
        10.0
    } else {
        9.0
    };
    let mut total = 0.0;
    for &child in dom.children(node) {
        match dom.node(child) {
            Node::Text(text) => {
                let words: Vec<&str> = text.split_whitespace().collect();
                let chars = words.iter().map(|w| w.chars().count()).sum::<usize>() + words.len().saturating_sub(1);
                total += chars as f64 * per;
            }
            Node::Element { attrs, .. } => {
                let mut inner = classes.to_vec();
                inner.extend(get(attrs, "class").split_whitespace());
                // Words in separate nodes are separated by a space the browser keeps.
                total += width(dom, child, &inner) + per;
            }
            _ => {}
        }
    }
    total
}

fn get<'a>(attrs: &'a [(String, String)], key: &str) -> &'a str {
    attrs.iter().find(|(k, _)| k == key).map_or("", |(_, v)| v.as_str())
}

/// A number as a diagram spells it: whole units without a fraction.
fn n(value: f64) -> String {
    if value.fract() == 0.0 { format!("{}", value as i64) } else { format!("{value:.1}") }
}
