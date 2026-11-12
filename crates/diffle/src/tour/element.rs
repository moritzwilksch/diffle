//! Reads an element's attributes as the catalog in `src/shared/tour-catalog.ts` does, and names the element in errors.
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use super::dom::NodeId;
use crate::protocol::TourError;

/// The element `tag` with `attrs`, as the catalog in `tour-catalog.ts` reads it, or why it does not fit.
pub fn parse<T: DeserializeOwned>(tag: &str, attrs: &[(String, String)]) -> Result<T, String> {
    // The tag is no attribute, though a struct that names it lists it among the fields.
    read::<T>(tag, attrs).map_err(|message| explain::<T>(tag, attrs, message).replace("`tag`, ", ""))
}

fn read<T: DeserializeOwned>(tag: &str, attrs: &[(String, String)]) -> Result<T, String> {
    let mut fields: Map<String, Value> = attrs.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect();
    fields.insert("tag".into(), Value::String(tag.into()));
    serde_json::from_value(Value::Object(fields)).map_err(|e| e.to_string())
}

/// `message` naming the attribute whose value failed its pattern, which serde's message leaves out.
fn explain<T: DeserializeOwned>(tag: &str, attrs: &[(String, String)], message: String) -> String {
    if !message.starts_with("doesn't match pattern") {
        return message;
    }
    // Alone, a bad value fails on its pattern before any missing attribute is noticed.
    let culprit = attrs.iter().find(|a| read::<T>(tag, std::slice::from_ref(a)).is_err_and(|m| m == message));
    culprit.map_or(message.clone(), |(name, _)| format!("{name}: {message}"))
}

/// The value of the attribute `name` in `attrs`.
pub fn attr<'a>(attrs: &'a [(String, String)], name: &str) -> Option<&'a str> {
    attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
}

/// Whether `value` spells a positive number, as `colspan` and `rowspan` take one.
pub fn is_count(value: &str) -> bool {
    value.parse::<u16>().is_ok_and(|n| n > 0) && !value.starts_with('0')
}

/// How an error names an element: its tag with its attributes as written.
pub fn label(tag: &str, attrs: &[(String, String)]) -> String {
    let attrs: String = attrs.iter().map(|(k, v)| format!(" {k}=\"{}\"", short(v))).collect();
    if tag.starts_with("diffle-") { format!("{tag}{attrs}") } else { format!("<{tag}{attrs}>") }
}

/// The first line of `text`, cut to 40 characters.
pub fn short(text: &str) -> String {
    let line = text.lines().next().unwrap_or_default();
    let cut: String = line.chars().take(40).collect();
    if cut.len() < text.len() { format!("{cut}…") } else { cut }
}

/// What is wrong with an element, and the judgment calls about it, each with the node it is about.
#[derive(Default)]
pub struct Findings {
    pub errors: Vec<(NodeId, TourError)>,
    pub warnings: Vec<(NodeId, TourError)>,
}

impl Findings {
    pub fn error(&mut self, node: NodeId, element: String, message: impl Into<String>) {
        self.errors.push((node, TourError { element, message: message.into() }));
    }

    pub fn warn(&mut self, node: NodeId, element: String, message: impl Into<String>) {
        self.warnings.push((node, TourError { element, message: message.into() }));
    }
}
