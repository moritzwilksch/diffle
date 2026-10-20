//! What one server reports while it runs: its output channel, the notice it shows, its progress.
use std::collections::BTreeMap;
use std::num::NonZeroU64;

use serde_json::Value;

use crate::iterations::now_ms;
use crate::protocol::{LspLogCounts, LspLogEntry, LspLogLevel, LspLogSource, LspNotice, LspNoticeSeverity};

/// Log lines kept per server; older ones are dropped.
const LOG_CAPACITY: usize = 200;

/// The status fields one piece of output moves.
#[derive(Clone, Debug)]
pub enum OutputChange {
    Log(LspLogCounts),
    Notice(LspNotice),
    Activity(Vec<String>),
}

struct Progress {
    title: String,
    message: Option<String>,
    percentage: Option<f64>,
}

/// Collects a server's output channel (what it showed, what it logged, what it wrote to stderr),
/// the notice it shows the reader, and the progress it runs. Each change goes to `on_change` as the
/// status field it moves. Only the log's summary travels with the status: whoever shows the lines
/// fetches them.
pub struct ServerOutput {
    log: Vec<LspLogEntry>,
    next_id: u64,
    summary: LspLogCounts,
    /// stderr bytes since the last newline.
    stderr_tail: String,
    notice: Option<LspNotice>,
    /// Keyed by the token's JSON text, ordered by when each piece began.
    progress: BTreeMap<(u64, String), Progress>,
    began: u64,
    on_change: Box<dyn Fn(OutputChange) + Send + Sync>,
}

impl ServerOutput {
    pub fn new(on_change: impl Fn(OutputChange) + Send + Sync + 'static) -> Self {
        Self {
            log: Vec::new(),
            next_id: 1,
            summary: LspLogCounts { seq: 0, errors: 0, warnings: 0 },
            stderr_tail: String::new(),
            notice: None,
            progress: BTreeMap::new(),
            began: 0,
            on_change: Box::new(on_change),
        }
    }

    /// The retained log lines, oldest first.
    pub fn entries(&self) -> Vec<LspLogEntry> {
        self.log.clone()
    }

    pub fn summary(&self) -> LspLogCounts {
        self.summary.clone()
    }

    /// Whole stderr lines go to the log; a trailing partial line waits for its newline.
    pub fn stderr(&mut self, chunk: &str) {
        let joined = std::mem::take(&mut self.stderr_tail) + chunk;
        let mut lines: Vec<&str> = joined.split('\n').collect();
        self.stderr_tail = lines.pop().unwrap_or_default().to_owned();
        for line in lines {
            if !line.trim().is_empty() {
                self.record(LspLogSource::Stderr, LspLogLevel::Log, line);
            }
        }
    }

    /// A server-to-client message: `window/*Message*` lands in the log, `$/progress` in the activity.
    pub fn message(&mut self, method: &str, params: &Value) {
        if !params.is_object() {
            return;
        }
        match method {
            "window/showMessage" | "window/logMessage" | "window/showMessageRequest" => {
                let Some(text) = params.get("message").and_then(Value::as_str).filter(|m| !m.trim().is_empty()) else {
                    return;
                };
                let level = match params.get("type").and_then(Value::as_i64) {
                    Some(1) => LspLogLevel::Error,
                    Some(2) => LspLogLevel::Warning,
                    Some(3) => LspLogLevel::Info,
                    _ => LspLogLevel::Log,
                };
                let source = if method == "window/logMessage" { LspLogSource::Log } else { LspLogSource::Message };
                self.record(source, level, text);
                // Only what the server shows the reader, and only a problem, stands as the notice: an
                // editor pops those up and files the rest in an output channel.
                let severity = match level {
                    LspLogLevel::Error => LspNoticeSeverity::Error,
                    LspLogLevel::Warning => LspNoticeSeverity::Warning,
                    _ => return,
                };
                if method == "window/logMessage" {
                    return;
                }
                let notice = LspNotice { severity, message: text.trim().to_owned() };
                if self.notice.as_ref().is_some_and(|n| n.severity == notice.severity && n.message == notice.message) {
                    return;
                }
                self.notice = Some(notice.clone());
                (self.on_change)(OutputChange::Notice(notice));
            }
            "$/progress" => self.note_progress(params),
            _ => {}
        }
    }

    /// Appends to the log, folding a line the server repeats into the previous entry's count.
    fn record(&mut self, source: LspLogSource, level: LspLogLevel, message: &str) {
        let text = message.trim();
        if text.is_empty() {
            return;
        }
        match self.log.last_mut() {
            Some(last) if last.source == source && last.level == level && last.message == text => {
                last.count = last.count.saturating_add(1);
                last.time = now_ms();
            }
            _ => {
                let id = NonZeroU64::new(self.next_id).expect("ids start at 1");
                self.next_id += 1;
                let count = NonZeroU64::MIN;
                self.log.push(LspLogEntry { id, time: now_ms(), source, level, message: text.to_owned(), count });
                if self.log.len() > LOG_CAPACITY {
                    self.log.remove(0);
                }
            }
        }
        self.summary.seq += 1;
        self.summary.errors += i64::from(level == LspLogLevel::Error);
        self.summary.warnings += i64::from(level == LspLogLevel::Warning);
        (self.on_change)(OutputChange::Log(self.summary.clone()));
    }

    /// Work-done progress by token; the activity lists every piece still running.
    fn note_progress(&mut self, p: &Value) {
        let token = match p.get("token") {
            Some(t @ (Value::String(_) | Value::Number(_))) => t.to_string(),
            _ => return,
        };
        let Some(value) = p.get("value").filter(|v| v.is_object()) else { return };
        let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
        let percent = value.get("percentage").and_then(Value::as_f64).filter(|p| (0.0..=100.0).contains(p));
        let key = self.progress.keys().find(|(_, t)| *t == token).cloned();
        match (value.get("kind").and_then(Value::as_str), key) {
            (Some("begin"), key) => {
                let Some(title) = text("title") else { return };
                // A token begun again keeps its place, as a Map entry set twice does.
                let key = key.unwrap_or_else(|| {
                    self.began += 1;
                    (self.began, token)
                });
                self.progress.insert(key, Progress { title, message: text("message"), percentage: percent });
            }
            (Some("report"), Some(key)) => {
                let piece = self.progress.get_mut(&key).expect("a running piece");
                if let Some(message) = text("message") {
                    piece.message = Some(message);
                }
                if percent.is_some() {
                    piece.percentage = percent;
                }
            }
            (Some("end"), Some(key)) => {
                self.progress.remove(&key);
            }
            _ => return,
        }
        let activity = self
            .progress
            .values()
            .map(|p| {
                let percent = p.percentage.map_or_else(String::new, |n| format!(" ({}%)", number(n)));
                let message = p.message.as_ref().map_or_else(String::new, |m| format!(": {m}"));
                format!("{}{percent}{message}", p.title)
            })
            .collect();
        (self.on_change)(OutputChange::Activity(activity));
    }
}

/// A percentage as JavaScript prints it: `40`, not `40.0`.
fn number(n: f64) -> String {
    if n.fract() == 0.0 { format!("{}", n as i64) } else { n.to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    fn output() -> (ServerOutput, Arc<Mutex<Vec<OutputChange>>>) {
        let changes = Arc::new(Mutex::new(Vec::new()));
        let record = changes.clone();
        (ServerOutput::new(move |c| record.lock().unwrap().push(c)), changes)
    }

    #[test]
    fn logs_whole_stderr_lines_and_folds_repeats() {
        let (mut out, _) = output();
        out.stderr("one\ntw");
        out.stderr("o\n\n  \ntwo\n");
        let lines: Vec<_> = out.entries().iter().map(|e| (e.message.clone(), e.count.get())).collect();
        assert_eq!(lines, [("one".into(), 1), ("two".into(), 2)]);
        assert_eq!(out.summary().seq, 3);
    }

    #[test]
    fn lets_only_shown_problems_stand_as_the_notice() {
        let (mut out, changes) = output();
        out.message("window/logMessage", &json!({ "type": 1, "message": "logged error" }));
        out.message("window/showMessage", &json!({ "type": 3, "message": "fyi" }));
        out.message("window/showMessage", &json!({ "type": 2, "message": " careful " }));
        out.message("window/showMessage", &json!({ "type": 2, "message": "careful" }));
        let notices: Vec<_> = changes
            .lock()
            .unwrap()
            .iter()
            .filter_map(|c| match c {
                OutputChange::Notice(n) => Some(n.message.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(notices, ["careful"]);
        let s = out.summary();
        // The trimmed repeat folds into the line before it.
        assert_eq!((s.errors, s.warnings, out.entries().len()), (1, 2, 3));
    }

    #[test]
    fn lists_running_progress_in_order_of_beginning() {
        let (mut out, changes) = output();
        let progress = |token: Value, value: Value| json!({ "token": token, "value": value });
        out.message(
            "$/progress",
            &progress(json!("a"), json!({ "kind": "begin", "title": "Indexing", "percentage": 10 })),
        );
        out.message(
            "$/progress",
            &progress(json!(2), json!({ "kind": "begin", "title": "Loading", "message": "crates" })),
        );
        out.message(
            "$/progress",
            &progress(json!("a"), json!({ "kind": "report", "message": "src", "percentage": 40 })),
        );
        out.message("$/progress", &progress(json!("x"), json!({ "kind": "report", "message": "unknown" })));
        let last = |changes: &Mutex<Vec<OutputChange>>| match changes.lock().unwrap().last() {
            Some(OutputChange::Activity(a)) => a.clone(),
            other => panic!("{other:?}"),
        };
        assert_eq!(last(&changes), ["Indexing (40%): src", "Loading: crates"]);
        out.message("$/progress", &progress(json!("a"), json!({ "kind": "end" })));
        out.message("$/progress", &progress(json!(2), json!({ "kind": "end" })));
        assert!(last(&changes).is_empty());
    }
}
