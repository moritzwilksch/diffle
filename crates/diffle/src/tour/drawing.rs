//! A diagram's geometry as the layout warnings read it: its boxes, labels and icons, and the
//! shapes that carry a tone.
use super::dom::{Dom, Node, NodeId};
use super::element::{attr, label};

/// An icon's width and height without `size`, as `Diagram.tsx` draws it.
pub const ICON_SIZE: f64 = 14.0;
const TONES: [&str; 4] = ["accent", "success", "warning", "error"];

/// A box, or a `frame` around a region.
pub struct Rect {
    pub node: NodeId,
    pub element: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub frame: bool,
}

/// A `<text>`.
pub struct Label {
    pub node: NodeId,
    pub element: String,
    pub x: f64,
    pub y: f64,
    /// Its estimated extent, left to right, from its anchor and the per-character widths.
    pub left: f64,
    pub right: f64,
    /// Whether it sits where its box's middle is: not an `eyebrow`, nor lines of `code`.
    pub centred: bool,
}

/// A Lucide icon, by its top-left corner and size.
pub struct Icon {
    pub node: NodeId,
    pub element: String,
    pub x: f64,
    pub y: f64,
    pub size: f64,
}

#[derive(Default)]
pub struct Drawing {
    pub rects: Vec<Rect>,
    pub labels: Vec<Label>,
    pub icons: Vec<Icon>,
    /// Shapes that are nodes (not frames), and how many of them carry a tone.
    pub shapes: usize,
    pub toned: usize,
}

impl Drawing {
    /// The drawing inside `svg`, each element named after `context`.
    pub fn read(dom: &Dom, svg: NodeId, context: &str) -> Self {
        let mut drawing = Self::default();
        for &child in dom.children(svg) {
            drawing.visit(dom, child, false, context);
        }
        drawing
    }

    fn visit(&mut self, dom: &Dom, node: NodeId, toned: bool, context: &str) {
        let Node::Element { name, attrs } = dom.node(node) else { return };
        let tag = &*name.local;
        let classes: Vec<&str> = attr(attrs, "class").unwrap_or_default().split_whitespace().collect();
        let toned = toned || classes.iter().any(|c| TONES.contains(c));
        let element = format!("{context}{}", label(tag, attrs));
        let num = |key: &str| attr(attrs, key).unwrap_or_default().parse::<f64>().unwrap_or(0.0);
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
                let code = classes.contains(&"code");
                // Lines of code are one `tspan` each: the widest line is the label's width.
                let wide = if code {
                    let lines = dom.children(node).iter().filter(|&&c| matches!(dom.node(c), Node::Element { .. }));
                    lines.map(|&c| width(dom, c, &classes)).fold(0.0, f64::max)
                } else {
                    width(dom, node, &classes)
                };
                let (x, y) = (num("x"), num("y"));
                let left = if classes.contains(&"c") {
                    x - wide / 2.0
                } else if classes.contains(&"e") {
                    x - wide
                } else {
                    x
                };
                let centred = !code && !classes.contains(&"eyebrow");
                self.labels.push(Label { node, element, x, y, left, right: left + wide, centred });
            }
            "svg" => {
                let size = if attr(attrs, "size").unwrap_or_default().is_empty() { ICON_SIZE } else { num("size") };
                self.icons.push(Icon { node, element, x: num("x"), y: num("y"), size });
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
    pub fn box_of(&self, text: &Label) -> Option<&Rect> {
        self.box_at(text.x, text.y)
    }

    /// The smallest box, not a frame, whose area holds the point.
    fn box_at(&self, x: f64, y: f64) -> Option<&Rect> {
        let holds = |r: &&Rect| !r.frame && (r.x..=r.x + r.w).contains(&x) && (r.y..=r.y + r.h).contains(&y);
        self.rects.iter().filter(holds).min_by(|a, b| (a.w * a.h).total_cmp(&(b.w * b.h)))
    }

    pub fn icon_box(&self, icon: &Icon) -> Option<&Rect> {
        self.box_at(icon.x + icon.size / 2.0, icon.y + icon.size / 2.0)
    }
}

/// A label's width by the `--skill` estimate, measured from Chromium's rendering of the UI fonts:
/// per character 6 units, 5.5 in `small` and `eyebrow`; a `tspan` adds its own classes to its text's.
fn width(dom: &Dom, node: NodeId, classes: &[&str]) -> f64 {
    let per = if classes.iter().any(|c| matches!(*c, "small" | "eyebrow")) { 5.5 } else { 6.0 };
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
                inner.extend(attr(attrs, "class").unwrap_or_default().split_whitespace());
                // Words in separate nodes are separated by a space the browser keeps.
                total += width(dom, child, &inner) + per;
            }
            _ => {}
        }
    }
    total
}
