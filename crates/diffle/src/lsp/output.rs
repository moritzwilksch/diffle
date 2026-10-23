//! What one server reports while it runs: its output channel, the notice it shows, its progress.
use std::num::NonZeroU64;

use async_lsp::lsp_types::{MessageType, NumberOrString, ProgressParams, ProgressParamsValue, WorkDoneProgress};
use indexmap::IndexMap;

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
    percentage: Option<u32>,
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
    /// By token, in the order each piece began.
    progress: IndexMap<NumberOrString, Progress>,
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
            progress: IndexMap::new(),
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

    /// A `window/logMessage`: filed in the log.
    pub fn log(&mut self, typ: MessageType, message: &str) {
        self.record(LspLogSource::Log, level_of(typ), message);
    }

    /// A `window/showMessage` or `window/showMessageRequest`: filed in the log, and a problem stands
    /// as the notice, as an editor pops those up and files the rest in an output channel.
    pub fn show(&mut self, typ: MessageType, message: &str) {
        let level = level_of(typ);
        self.record(LspLogSource::Message, level, message);
        let severity = match level {
            LspLogLevel::Error => LspNoticeSeverity::Error,
            LspLogLevel::Warning => LspNoticeSeverity::Warning,
            _ => return,
        };
        let notice = LspNotice { severity, message: message.trim().to_owned() };
        if notice.message.is_empty()
            || self.notice.as_ref().is_some_and(|n| n.severity == severity && n.message == notice.message)
        {
            return;
        }
        self.notice = Some(notice.clone());
        (self.on_change)(OutputChange::Notice(notice));
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
    pub fn progress(&mut self, p: ProgressParams) {
        let ProgressParamsValue::WorkDone(value) = p.value;
        match value {
            // A token begun again keeps its place.
            WorkDoneProgress::Begin(b) => {
                let piece = Progress { title: b.title, message: b.message, percentage: b.percentage };
                self.progress.insert(p.token, piece);
            }
            WorkDoneProgress::Report(r) => {
                let Some(piece) = self.progress.get_mut(&p.token) else { return };
                piece.message = r.message.or(piece.message.take());
                piece.percentage = r.percentage.or(piece.percentage);
            }
            WorkDoneProgress::End(_) => {
                if self.progress.shift_remove(&p.token).is_none() {
                    return;
                }
            }
        }
        let activity = self
            .progress
            .values()
            .map(|p| {
                let percent = p.percentage.map_or_else(String::new, |n| format!(" ({n}%)"));
                let message = p.message.as_ref().map_or_else(String::new, |m| format!(": {m}"));
                format!("{}{percent}{message}", p.title)
            })
            .collect();
        (self.on_change)(OutputChange::Activity(activity));
    }
}

fn level_of(typ: MessageType) -> LspLogLevel {
    match typ {
        MessageType::ERROR => LspLogLevel::Error,
        MessageType::WARNING => LspLogLevel::Warning,
        MessageType::INFO => LspLogLevel::Info,
        _ => LspLogLevel::Log,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
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
        out.log(MessageType::ERROR, "logged error");
        out.show(MessageType::INFO, "fyi");
        out.show(MessageType::WARNING, " careful ");
        out.show(MessageType::WARNING, "careful");
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
        let mut progress = |token: Value, value: Value| {
            out.progress(serde_json::from_value(json!({ "token": token, "value": value })).unwrap())
        };
        progress(json!("a"), json!({ "kind": "begin", "title": "Indexing", "percentage": 10 }));
        progress(json!(2), json!({ "kind": "begin", "title": "Loading", "message": "crates" }));
        progress(json!("a"), json!({ "kind": "report", "message": "src", "percentage": 40 }));
        progress(json!("x"), json!({ "kind": "report", "message": "unknown" }));
        let last = |changes: &Mutex<Vec<OutputChange>>| match changes.lock().unwrap().last() {
            Some(OutputChange::Activity(a)) => a.clone(),
            other => panic!("{other:?}"),
        };
        assert_eq!(last(&changes), ["Indexing (40%): src", "Loading: crates"]);
        progress(json!("a"), json!({ "kind": "end" }));
        progress(json!(2), json!({ "kind": "end" }));
        assert!(last(&changes).is_empty());
    }
}
