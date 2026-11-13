//! A diagram's geometry as comment anchors read it: its boxes and labels.
use super::dom::{Dom, Node, NodeId};
use super::element::attr;

/// A box, or a `frame` around a region.
pub struct Rect {
    pub node: NodeId,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub frame: bool,
}

/// A `<text>`, by its anchor.
pub struct Label {
    pub node: NodeId,
    pub x: f64,
    pub y: f64,
}

#[derive(Default)]
pub struct Drawing {
    pub rects: Vec<Rect>,
    pub labels: Vec<Label>,
}

impl Drawing {
    /// The drawing inside `svg`.
    pub fn read(dom: &Dom, svg: NodeId) -> Self {
        let mut drawing = Self::default();
        for &child in dom.children(svg) {
            drawing.visit(dom, child);
        }
        drawing
    }

    fn visit(&mut self, dom: &Dom, node: NodeId) {
        let Node::Element { name, attrs } = dom.node(node) else { return };
        let num = |key: &str| attr(attrs, key).unwrap_or_default().parse::<f64>().unwrap_or(0.0);
        match &*name.local {
            "rect" => {
                let frame = attr(attrs, "class").unwrap_or_default().split_whitespace().any(|c| c == "frame");
                let (x, y, w, h) = (num("x"), num("y"), num("width"), num("height"));
                self.rects.push(Rect { node, x, y, w, h, frame });
            }
            "text" => self.labels.push(Label { node, x: num("x"), y: num("y") }),
            "g" => {
                for &child in dom.children(node) {
                    self.visit(dom, child);
                }
            }
            _ => {}
        }
    }

    /// The smallest box, not a frame, whose area holds the label's anchor.
    pub fn box_of(&self, text: &Label) -> Option<&Rect> {
        let (x, y) = (text.x, text.y);
        let holds = |r: &&Rect| !r.frame && (r.x..=r.x + r.w).contains(&x) && (r.y..=r.y + r.h).contains(&y);
        self.rects.iter().filter(holds).min_by(|a, b| (a.w * a.h).total_cmp(&(b.w * b.h)))
    }
}
