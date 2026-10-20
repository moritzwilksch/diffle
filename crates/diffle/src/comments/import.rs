//! Parsing `POST /api/threads` payloads and telling duplicates apart.
use std::future::Future;
use std::num::NonZeroU64;

use serde_json::{Map, Value};

use super::anchor::anchor_path;
use super::store::{CommentStore, new_thread, read_store_file, write_store_file};
use crate::error::{Error, Result};
use crate::persist::with_file_lock;
use crate::protocol::{CommentAnchor, CommentThread, Side, ThreadCreate, ThreadCreatePath};

/// Everything `POST /api/threads` accepts: 1 MiB, like the HTTP body limit.
const MAX_PAYLOAD_BYTES: usize = 1024 * 1024;
/// JavaScript's largest exact integer: the protocol's bound on a line number.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Parses a payload given as JSON text; see `parse_imports`.
pub fn parse_imports_text(raw: &str) -> Result<Vec<ThreadCreate>> {
    if raw.len() > MAX_PAYLOAD_BYTES {
        return Err(Error::Invalid("comment payload over 1 MiB".into()));
    }
    let value: Value = serde_json::from_str(raw).map_err(|e| Error::Invalid(format!("invalid comment JSON: {e}")))?;
    parse_imports(&value)
}

/// Parses one ThreadCreate object, or an array of them. Unknown fields are dropped; any malformed
/// entry fails the whole payload, naming its index.
pub fn parse_imports(raw: &Value) -> Result<Vec<ThreadCreate>> {
    let list: Vec<&Value> = match raw {
        Value::Array(items) => items.iter().collect(),
        one => vec![one],
    };
    let indexed = list.len() > 1;
    list.into_iter()
        .enumerate()
        .map(|(i, entry)| {
            to_thread_create(entry).map_err(|issues| {
                let at = if indexed { format!("[{i}]") } else { String::new() };
                Error::Invalid(format!("invalid comment{at}: {}", issues.join("; ")))
            })
        })
        .collect()
}

/// ThreadCreateSchema by hand, issues worded as zod words them: the shape first, then the refinements.
fn to_thread_create(entry: &Value) -> Result<ThreadCreate, Vec<String>> {
    let Value::Object(fields) = entry else {
        return Err(vec![format!(": Invalid input: expected object, received {}", kind(entry))]);
    };
    let mut issues = Vec::new();
    let path = string(fields, "path", &mut issues);
    if path.as_deref() == Some("") {
        issues.push("path: Too small: expected string to have >=1 characters".into());
    }
    let side = match fields.get("side") {
        None => None,
        Some(Value::String(s)) if s == "old" => Some(Side::Old),
        Some(Value::String(s)) if s == "new" => Some(Side::New),
        Some(_) => {
            issues.push(r#"side: Invalid option: expected one of "old"|"new""#.into());
            None
        }
    };
    let start = line(fields, "startLine", &mut issues);
    let end = line(fields, "endLine", &mut issues);
    let body = string(fields, "body", &mut issues);
    if body.as_deref().is_some_and(|b| b.trim().is_empty()) {
        issues.push("body: body required".into());
    }
    let quoted = optional_string(fields, "quoted", &mut issues);
    if !issues.is_empty() {
        return Err(issues);
    }
    if let (Some(s), Some(e)) = (start, end)
        && e < s
    {
        issues.push("endLine: endLine must be ≥ startLine".into());
    }
    if start.is_none() && (side.is_some() || end.is_some() || quoted.is_some()) {
        issues.push(
            "startLine: side, endLine and quoted need a startLine; leave all four out for a comment on the whole file"
                .into(),
        );
    }
    if !issues.is_empty() {
        return Err(issues);
    }
    Ok(ThreadCreate {
        path: ThreadCreatePath::try_from(path.unwrap_or_default()).map_err(|e| vec![format!("path: {e}")])?,
        side,
        start_line: start,
        end_line: end,
        body: body.unwrap_or_default(),
        quoted,
    })
}

fn kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn string(fields: &Map<String, Value>, name: &str, issues: &mut Vec<String>) -> Option<String> {
    match fields.get(name) {
        Some(Value::String(s)) => Some(s.clone()),
        other => {
            let received = other.map_or("undefined", kind);
            issues.push(format!("{name}: Invalid input: expected string, received {received}"));
            None
        }
    }
}

fn optional_string(fields: &Map<String, Value>, name: &str, issues: &mut Vec<String>) -> Option<String> {
    fields.get(name)?;
    string(fields, name, issues)
}

fn line(fields: &Map<String, Value>, name: &str, issues: &mut Vec<String>) -> Option<NonZeroU64> {
    let value = fields.get(name)?;
    let Some(n) = value.as_f64() else {
        issues.push(format!("{name}: Invalid input: expected number, received {}", kind(value)));
        return None;
    };
    if n.fract() != 0.0 || n.abs() > MAX_SAFE_INTEGER {
        issues.push(format!("{name}: Invalid input: expected int, received number"));
        return None;
    }
    if n <= 0.0 {
        issues.push(format!("{name}: Too small: expected number to be >0"));
        return None;
    }
    NonZeroU64::new(n as u64)
}

/// True when `t` duplicates an open thread at the same anchor whose opening message has the same body.
pub fn is_duplicate(existing: &[CommentThread], t: &ThreadCreate) -> bool {
    let body = t.body.trim();
    let mut open = existing.iter().filter(|e| {
        !e.resolved
            && anchor_path(&e.anchor) == t.path.as_str()
            && e.messages.first().is_some_and(|m| m.body.trim() == body)
    });
    let Some(start) = t.start_line else {
        return open.any(|e| matches!(e.anchor, CommentAnchor::File { .. }));
    };
    let (side, start) = (t.side.unwrap_or(Side::New), start.get() as i64);
    let end = t.end_line.map_or(start, |e| e.get() as i64);
    open.any(|e| {
        matches!(&e.anchor, CommentAnchor::Line { side: s, start_line, end_line, .. }
            if *s == side && *start_line == start && *end_line == end)
    })
}

/// Places imported anchors against the snapshot, behind the session's allowlist.
pub trait AnchorSource: Sync {
    /// The exact text of a range on one side, for `quoted`; none when the range cannot be read.
    fn quote(
        &self,
        path: &str,
        side: Side,
        start: i64,
        end: i64,
    ) -> impl Future<Output = Result<Option<String>>> + Send;
    /// Whether the review has a file at `path` on either side.
    fn has_file(&self, path: &str) -> impl Future<Output = Result<bool>> + Send;
}

impl CommentStore {
    /// Adds each import that is not already an open duplicate, returning (added, skipped). Every
    /// anchor is checked against the snapshot through `source`: a range is quoted (a payload's own
    /// `quoted`, the text the browser showed, is kept once the range is known to exist) and a file
    /// thread's path must be in the review. Fails with `Unquotable`, adding nothing, when any
    /// anchor cannot be placed.
    pub async fn import_threads(
        &self,
        imports: Vec<ThreadCreate>,
        source: &impl AnchorSource,
    ) -> Result<(Vec<CommentThread>, usize)> {
        with_file_lock(&self.file, || async {
            let mut all = read_store_file(&self.file).await?;
            let mut set = all.sets.remove(&self.key).unwrap_or_default();
            let mut existing = set.threads.clone();
            let (mut added, mut skipped) = (Vec::new(), 0);
            for t in imports {
                if is_duplicate(&existing, &t) {
                    skipped += 1;
                    continue;
                }
                let anchor = match place_import(&t, source).await {
                    Ok(anchor) => anchor,
                    Err(e) => return Ok(Err(e)),
                };
                let thread = new_thread(anchor, t.body);
                // Later imports in the same batch may duplicate this one.
                existing.push(thread.clone());
                added.push(thread);
            }
            if !added.is_empty() {
                set.threads.extend(added.iter().cloned());
                all.sets.insert(self.key.clone(), set);
                write_store_file(&self.file, &all).await?;
            }
            Ok(Ok((added, skipped)))
        })
        .await?
    }
}

/// The anchor an import lands on, checked against the snapshot.
async fn place_import(t: &ThreadCreate, source: &impl AnchorSource) -> Result<CommentAnchor> {
    let path = t.path.as_str();
    let Some(start) = t.start_line.map(|s| s.get() as i64) else {
        if !source.has_file(path).await? {
            return Err(Error::Unquotable(format!("{path} is not in the review")));
        }
        return Ok(CommentAnchor::File { path: path.into() });
    };
    let side = t.side.unwrap_or(Side::New);
    let end = t.end_line.map_or(start, |e| e.get() as i64);
    let Some(from_snapshot) = source.quote(path, side, start, end).await? else {
        let range = if end != start { format!("{start}-{end}") } else { start.to_string() };
        let side = if side == Side::Old { "old" } else { "new" };
        return Err(Error::Unquotable(format!("cannot quote {path}:{range} on the {side} side")));
    };
    let quoted = t.quoted.clone().unwrap_or(from_snapshot);
    Ok(CommentAnchor::Line { path: path.into(), side, start_line: start, end_line: end, quoted })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::CommentMessage;
    use serde_json::json;

    fn err(value: Value) -> String {
        parse_imports(&value).unwrap_err().to_string()
    }

    fn summary(t: &ThreadCreate) -> Value {
        serde_json::to_value(t).unwrap()
    }

    #[test]
    fn accepts_one_object_or_an_array_as_text_or_a_value_keeping_only_known_fields() {
        let one = json!({ "path": "a.py", "startLine": 3, "body": "x", "extra": 1 });
        let parsed = parse_imports_text(&one.to_string()).unwrap();
        assert_eq!(summary(&parsed[0]), json!({ "path": "a.py", "startLine": 3, "body": "x" }));
        let two = json!([one, { "path": "b.py", "side": "old", "startLine": 1, "endLine": 2, "body": "y", "author": "agent", "quoted": "q" }]);
        let parsed = parse_imports(&two).unwrap();
        assert_eq!(
            summary(&parsed[1]),
            json!({ "path": "b.py", "side": "old", "startLine": 1, "endLine": 2, "body": "y", "quoted": "q" })
        );
    }

    #[test]
    fn reads_a_payload_without_a_line_as_a_file_comment_and_refuses_line_fields_without_one() {
        let file = parse_imports(&json!({ "path": "a.py", "body": "Split this." })).unwrap();
        assert_eq!(summary(&file[0]), json!({ "path": "a.py", "body": "Split this." }));
        for (key, value) in [("side", json!("new")), ("endLine", json!(2)), ("quoted", json!("q"))] {
            let mut payload = json!({ "path": "a.py", "body": "x" });
            payload[key] = value;
            assert!(err(payload).contains("startLine"));
        }
    }

    #[test]
    fn rejects_malformed_payloads_with_the_offending_index() {
        assert!(matches!(parse_imports_text("{not json"), Err(Error::Invalid(_))));
        let message = err(
            json!([{ "path": "a.py", "startLine": 1, "body": "ok" }, { "path": "a.py", "startLine": 0, "body": "x" }]),
        );
        assert!(message.contains("[1]") && message.contains("startLine"), "{message}");
        assert!(err(json!({ "path": "a.py", "startLine": 2, "endLine": 1, "body": "x" })).contains("endLine"));
        assert!(err(json!({ "path": "a.py", "startLine": 1, "body": "  " })).contains("body"));
        assert!(err(json!({ "path": "a.py", "startLine": 1, "body": "x", "side": "left" })).contains("side"));
        assert!(err(json!("a string")).contains("object"));
        assert!(err(json!({ "path": "", "body": "x" })).contains("path"));
        assert!(
            matches!(parse_imports_text(&" ".repeat(MAX_PAYLOAD_BYTES + 1)), Err(Error::Invalid(m)) if m == "comment payload over 1 MiB")
        );
    }

    fn thread(id: &str, anchor: CommentAnchor, body: &str, resolved: bool) -> CommentThread {
        CommentThread {
            id: id.into(),
            anchor,
            messages: vec![CommentMessage { id: "m".into(), body: body.into(), created_at: 0, updated_at: 0 }],
            resolved,
            resolved_at: None,
            stale: false,
            stale_from_line: None,
        }
    }

    fn create(value: Value) -> ThreadCreate {
        parse_imports(&value).unwrap().remove(0)
    }

    fn line(start: i64, end: i64) -> CommentAnchor {
        CommentAnchor::Line {
            path: "a.py".into(),
            side: Side::New,
            start_line: start,
            end_line: end,
            quoted: "q".into(),
        }
    }

    #[test]
    fn matches_file_comments_by_path_and_body_and_lines_by_side_range_and_body_on_open_threads() {
        let existing = vec![
            thread("1", line(3, 4), "Same finding ", false),
            thread("2", line(8, 8), "Resolved finding", true),
            thread("3", CommentAnchor::File { path: "a.py".into() }, "Whole file", false),
        ];
        let dup = |v: Value| is_duplicate(&existing, &create(v));
        assert!(dup(json!({ "path": "a.py", "body": " Whole file" })));
        assert!(!dup(json!({ "path": "b.py", "body": "Whole file" })));
        assert!(!dup(json!({ "path": "a.py", "body": "Same finding" })));
        assert!(!dup(json!({ "path": "a.py", "startLine": 1, "body": "Whole file" })));
        assert!(dup(json!({ "path": "a.py", "startLine": 3, "endLine": 4, "body": "Same finding" })));
        assert!(!dup(json!({ "path": "a.py", "startLine": 3, "endLine": 4, "body": "Other finding" })));
        assert!(!dup(json!({ "path": "a.py", "startLine": 3, "body": "Same finding" })));
        assert!(!dup(json!({ "path": "a.py", "side": "old", "startLine": 3, "endLine": 4, "body": "Same finding" })));
        assert!(!dup(json!({ "path": "a.py", "startLine": 8, "body": "Resolved finding" })));
    }
}
