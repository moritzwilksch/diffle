//! Warnings about a diagram's layout, checked from its geometry against the rules `--skill` gives:
//! a label inside its box and on its middle, boxes on the grid and inside the drawing, the canvas
//! width, the share of toned shapes, and icons inside their boxes, clear of their text and on all
//! sibling boxes or none. What rests on the per-character estimate says "may"; a
//! geometric fact is said plainly.
use super::dom::{Dom, Node, NodeId};
use super::drawing::{Drawing, Rect};
use super::element::{attr, label};
use crate::protocol::TourError;

/// The article's column, and the gap between a row's columns, as `TourPage.tsx` and
/// `styles/tour.css` lay them out.
const PAGE_WIDTH: f64 = 920.0;
const ROW_GAP: f64 = 24.0;

/// How wide a column of a row of `columns` is when the page is at its widest.
pub fn column_width(columns: usize) -> f64 {
    let n = columns as f64;
    (PAGE_WIDTH - ROW_GAP * (n - 1.0)) / n
}
const GRID: f64 = 4.0;
/// The room between an icon and the text after it.
const ICON_GAP: f64 = 6.0;

/// Every layout warning about the `diffle-diagram` at `node`, which warnings name as `element`;
/// `columns` is the size of the row it sits in, 0 outside one.
pub fn warnings(dom: &Dom, node: NodeId, element: &str, columns: usize) -> Vec<(NodeId, TourError)> {
    let Some((svg, attrs)) = dom.children(node).iter().find_map(|&c| match dom.node(c) {
        Node::Element { name, attrs } if &*name.local == "svg" => Some((c, attrs)),
        _ => None,
    }) else {
        return Vec::new();
    };
    let view: Vec<f64> =
        attr(attrs, "viewBox").unwrap_or_default().split_whitespace().filter_map(|n| n.parse().ok()).collect();
    let [_, _, width, height] = view[..] else { return Vec::new() };
    let context = format!("{element} > ");
    let drawing = Drawing::read(dom, svg, &context);
    let mut found = Vec::new();
    let mut warn = |node: NodeId, element: &str, message: String| {
        found.push((node, TourError { element: element.into(), message }));
    };
    let svg_element = format!("{context}{}", label("svg", attrs));
    let (room, place) = match columns {
        0 => (PAGE_WIDTH, "the page is at most".to_owned()),
        _ => (
            column_width(columns),
            format!("a column in a row of {} is about", if columns == 2 { "two" } else { "three" }),
        ),
    };
    if width > room.floor() {
        let message = format!("Is {} wide; {place} {}, so it shrinks, text and all", n(width), n(room.floor()));
        warn(svg, &svg_element, message);
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
            warn(rect.node, &rect.element, format!("Is off the 4-unit grid: {}", off.join(", ")));
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
            drawing.labels.iter().filter(|l| l.centred && drawing.box_of(l).is_some_and(|b| b.node == home.node));
        let middle = home.y + home.h / 2.0;
        if text.centred && alone.count() == 1 && text.y != middle {
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
    found.extend(icon_warnings(&drawing, svg, &svg_element));
    found
}

/// Warnings about icons: each inside its box, on its middle and clear of its text, and either
/// every labelled box of a height carrying one or none.
fn icon_warnings(drawing: &Drawing, svg: NodeId, svg_element: &str) -> Vec<(NodeId, TourError)> {
    let mut found = Vec::new();
    let mut warn = |node: NodeId, element: &str, message: String| {
        found.push((node, TourError { element: element.into(), message }));
    };
    for icon in &drawing.icons {
        let Some(home) = drawing.icon_box(icon) else { continue };
        let (right, bottom) = (icon.x + icon.size, icon.y + icon.size);
        if icon.x < home.x || icon.y < home.y || right > home.x + home.w || bottom > home.y + home.h {
            let message = format!(
                "Runs past its box: it spans {}-{} across and {}-{} down, the box {}-{} and {}-{}",
                n(icon.x),
                n(right),
                n(icon.y),
                n(bottom),
                n(home.x),
                n(home.x + home.w),
                n(home.y),
                n(home.y + home.h)
            );
            warn(icon.node, &icon.element, message);
        }
        let (middle, centre) = (home.y + home.h / 2.0, icon.y + icon.size / 2.0);
        if centre != middle {
            let side = if centre > middle { "below" } else { "above" };
            let message = format!(
                "Sits {} {side} its box's vertical middle: at y {} it centres at {}, the middle is {}; set y to {}",
                n((centre - middle).abs()),
                n(icon.y),
                n(centre),
                n(middle),
                n(middle - icon.size / 2.0)
            );
            warn(icon.node, &icon.element, message);
        }
        let beside = drawing.labels.iter().filter(|l| drawing.box_of(l).is_some_and(|b| b.node == home.node));
        for text in beside.filter(|l| l.left < right + ICON_GAP && l.right > icon.x - ICON_GAP) {
            let message = format!(
                "May overlap the icon at x {}: start the text at x {}, {} after it",
                n(icon.x),
                n(right + ICON_GAP),
                n(ICON_GAP)
            );
            warn(text.node, &text.element, message);
        }
    }
    let labelled: Vec<&Rect> = drawing
        .rects
        .iter()
        .filter(|r| drawing.labels.iter().any(|l| drawing.box_of(l).is_some_and(|b| b.node == r.node)))
        .collect();
    let mut heights: Vec<f64> = labelled.iter().map(|r| r.h).collect();
    heights.sort_by(f64::total_cmp);
    heights.dedup();
    for height in heights {
        let boxes: Vec<&&Rect> = labelled.iter().filter(|r| r.h == height).collect();
        let marked = boxes
            .iter()
            .filter(|r| drawing.icons.iter().any(|i| drawing.icon_box(i).is_some_and(|b| b.node == r.node)));
        let marked = marked.count();
        if marked > 0 && marked < boxes.len() {
            let message = format!(
                "{marked} of {} labelled boxes {} tall carry an icon: give each one an icon, or none",
                boxes.len(),
                n(height)
            );
            warn(svg, svg_element, message);
        }
    }
    found
}

/// A number as a diagram spells it: whole units without a fraction.
fn n(value: f64) -> String {
    if value.fract() == 0.0 { format!("{}", value as i64) } else { format!("{value:.1}") }
}
