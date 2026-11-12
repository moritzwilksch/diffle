//! Reads an element's attributes as the catalog in `src/shared/tour-catalog.ts` does, and names the element in errors.
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use super::dom::NodeId;
use crate::protocol::{TourElement, TourError, TourSvgElement, TourSvgIcon};

/// A catalog type and the `$defs` entry of the contract that describes it.
pub trait Catalogued: DeserializeOwned {
    const DEF: &'static str;
}

impl Catalogued for TourElement {
    const DEF: &'static str = "TourElement";
}

impl Catalogued for TourSvgElement {
    const DEF: &'static str = "TourSvgElement";
}

impl Catalogued for TourSvgIcon {
    const DEF: &'static str = "TourSvgIcon";
}

/// The element `tag` with `attrs`, as the catalog in `tour-catalog.ts` reads it, or why it does not fit.
/// The attributes are checked against the contract's schema first, so every reason is worded here and
/// deserializing only ever sees attributes that fit.
pub fn parse<T: Catalogued>(tag: &str, attrs: &[(String, String)]) -> Result<T, String> {
    let Some(schema) = schema(T::DEF, tag) else {
        let tags = union(T::DEF).filter_map(|member| member["properties"]["tag"]["const"].as_str());
        return Err(format!("{tag} is not an element a tour may use; use {}", listed(tags, "or")));
    };
    check(&named(tag), schema, attrs)?;
    let mut fields: Map<String, Value> = attrs.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect();
    fields.insert("tag".into(), Value::String(tag.into()));
    // Unreachable for attributes the schema accepts: the generated type is that schema.
    serde_json::from_value(Value::Object(fields)).map_err(|e| format!("{tag} does not fit the catalog: {e}"))
}

/// Whether the catalog type at `def` has an element `tag`.
pub fn knows(def: &str, tag: &str) -> bool {
    schema(def, tag).is_some()
}

/// The schema of the element `tag` in the contract's `def`: one member of a union, or the object itself.
fn schema(def: &str, tag: &str) -> Option<&'static Value> {
    union(def).find(|member| member["properties"]["tag"]["const"] == tag)
}

fn union(def: &str) -> impl Iterator<Item = &'static Value> {
    let def = &crate::protocol::contract()["$defs"][def];
    def["oneOf"].as_array().map_or_else(|| std::slice::from_ref(def), Vec::as_slice).iter()
}

/// Why `attrs` do not fit `schema`, naming each attribute at fault: those it does not take, values
/// outside their enum or pattern, and those it needs. Every reason at once, so one fix does not
/// uncover the next.
fn check(name: &str, schema: &'static Value, attrs: &[(String, String)]) -> Result<(), String> {
    let properties = schema["properties"].as_object().map(|p| p.iter().filter(|(key, _)| *key != "tag"));
    let known: Vec<&str> = properties.into_iter().flatten().map(|(key, _)| key.as_str()).collect();
    let mut reasons = Vec::new();
    let unknown: Vec<&str> = attrs.iter().map(|(k, _)| k.as_str()).filter(|k| !known.contains(k)).collect();
    if !unknown.is_empty() {
        let unknown = listed(unknown.into_iter(), "or");
        reasons.push(format!("{name} takes no attribute {unknown}: it takes {}", listed(known.iter().copied(), "and")));
    }
    for (key, value) in attrs.iter().filter(|(k, _)| known.contains(&k.as_str())) {
        reasons.extend(misfit(key, value, resolve(&schema["properties"][key])));
    }
    let required = schema["required"].as_array().into_iter().flatten().filter_map(Value::as_str);
    for missing in required.filter(|key| *key != "tag" && !attrs.iter().any(|(k, _)| k == key)) {
        let meaning = described(&schema["properties"][missing]).map_or_else(String::new, |m| format!(": {m}"));
        reasons.push(format!("{name} takes {missing}=\"…\"{meaning}"));
    }
    if reasons.is_empty() { Ok(()) } else { Err(reasons.join("; ")) }
}

/// Why `value` does not fit the attribute `key`'s schema `property`.
fn misfit(key: &str, value: &str, property: &Value) -> Option<String> {
    if let Some(allowed) = property["enum"].as_array() {
        let fits = allowed.iter().any(|v| v == value);
        return (!fits)
            .then(|| format!("{key} is {}, not {value}", listed(allowed.iter().filter_map(Value::as_str), "or")));
    }
    if let Some(pattern) = property["pattern"].as_str() {
        let fits = regex::Regex::new(pattern).expect("the catalog's patterns compile").is_match(value);
        return (!fits).then(|| match described(property) {
            Some(meaning) => format!("{key}=\"{value}\" does not fit: {meaning}"),
            None => format!("{key}=\"{value}\" does not fit the form {pattern}"),
        });
    }
    let short = property["minLength"].as_u64().is_some_and(|min| value.chars().count() < min as usize);
    short.then(|| format!("{key} is empty"))
}

/// A property's schema, through the `$ref` that shared types such as `Side` take.
fn resolve(property: &'static Value) -> &'static Value {
    match property["$ref"].as_str().and_then(|r| r.strip_prefix("#/$defs/")) {
        Some(def) => &crate::protocol::contract()["$defs"][def],
        None => property,
    }
}

/// A property's description as the rest of a sentence: its first letter lowered, no closing period.
fn described(property: &Value) -> Option<String> {
    let text = property["description"].as_str()?.trim().trim_end_matches('.');
    let mut chars = text.chars();
    let first = chars.next()?;
    let first = if first == '`' { first.to_string() } else { first.to_lowercase().to_string() };
    Some(format!("{first}{}", chars.as_str()))
}

/// How a message names an element by its tag: bare for a `diffle-*` element, else in brackets.
fn named(tag: &str) -> String {
    if tag.starts_with("diffle-") { format!("a {tag}") } else { format!("a <{tag}>") }
}

/// `items` as prose: `a, b and c`.
fn listed<'a>(items: impl Iterator<Item = &'a str>, last: &str) -> String {
    let items: Vec<&str> = items.collect();
    match items.split_last() {
        Some((tail, [])) => (*tail).to_owned(),
        Some((tail, rest)) => format!("{} {last} {tail}", rest.join(", ")),
        None => "nothing".to_owned(),
    }
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
