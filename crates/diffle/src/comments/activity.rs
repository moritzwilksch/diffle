//! The bounded in-memory log of comment changes, each with its author: the one source of change
//! events, and what a waiting client learns happened since its cursor.
use std::collections::{BTreeSet, VecDeque};
use std::fmt;
use std::sync::Mutex;

use crate::protocol::CommentAuthor;

/// Entries kept; a cursor older than the oldest kept one resyncs.
const CAPACITY: usize = 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Change {
    /// A thread was created, replied to, edited, resolved, reopened or deleted.
    Thread(String),
    /// The shown comment set switched to another key.
    Key,
}

/// A position in one run's log: `<instance>:<seq>`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cursor {
    pub instance: String,
    pub seq: u64,
}

impl Cursor {
    /// `None` unless `text` is `<instance>:<seq>`.
    pub fn parse(text: &str) -> Option<Self> {
        let (instance, seq) = text.rsplit_once(':')?;
        if instance.is_empty() || !seq.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        Some(Self { instance: instance.to_owned(), seq: seq.parse().ok()? })
    }
}

impl fmt::Display for Cursor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.instance, self.seq)
    }
}

/// What follows a cursor in the log.
#[derive(Debug, PartialEq, Eq)]
pub enum Since {
    /// The cursor is another run's, or outside the log's window: start over from the full state.
    Lost,
    /// Nothing follows it but changes by the ignored author.
    Quiet,
    /// Something not ignored changed. `threads` names every thread changed after the cursor, by
    /// anyone, through `through`; `key` says whether the comment set switched in between.
    Changed { through: Cursor, threads: BTreeSet<String>, key: bool },
}

struct Entry {
    seq: u64,
    /// Absent: the reviewer.
    author: Option<CommentAuthor>,
    change: Change,
}

#[derive(Default)]
struct Log {
    /// The last sequence number handed out; 0 before the first entry.
    latest: u64,
    /// The last sequence number dropped from the window; 0 before the first drop.
    dropped: u64,
    entries: VecDeque<Entry>,
}

pub struct ActivityLog {
    /// The run's id, minted once; a cursor of another run means nothing here.
    instance: String,
    log: Mutex<Log>,
}

impl ActivityLog {
    pub fn new(instance: String) -> Self {
        Self { instance, log: Mutex::default() }
    }

    pub fn instance(&self) -> &str {
        &self.instance
    }

    /// Appends each change with its author; answers the cursor after them, or none when there were none.
    pub fn record(&self, changes: impl IntoIterator<Item = (Option<CommentAuthor>, Change)>) -> Option<Cursor> {
        let mut log = self.log.lock().unwrap();
        let before = log.latest;
        for (author, change) in changes {
            log.latest += 1;
            let seq = log.latest;
            log.entries.push_back(Entry { seq, author, change });
            if log.entries.len() > CAPACITY {
                log.dropped = log.entries.pop_front().expect("over capacity").seq;
            }
        }
        (log.latest != before).then(|| self.at(log.latest))
    }

    /// The cursor after the latest change.
    pub fn cursor(&self) -> Cursor {
        self.at(self.log.lock().unwrap().latest)
    }

    fn at(&self, seq: u64) -> Cursor {
        Cursor { instance: self.instance.clone(), seq }
    }

    /// What follows `cursor`; changes by `ignore` alone leave it quiet.
    pub fn since(&self, cursor: &Cursor, ignore: Option<CommentAuthor>) -> Since {
        let log = self.log.lock().unwrap();
        if cursor.instance != self.instance || cursor.seq < log.dropped || cursor.seq > log.latest {
            return Since::Lost;
        }
        let after = log.entries.iter().filter(|e| e.seq > cursor.seq);
        if after.clone().all(|e| ignore.is_some() && e.author == ignore) {
            return Since::Quiet;
        }
        let mut threads = BTreeSet::new();
        let mut key = false;
        for entry in after {
            match &entry.change {
                Change::Thread(id) => drop(threads.insert(id.clone())),
                Change::Key => key = true,
            }
        }
        Since::Changed { through: self.at(log.latest), threads, key }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AGENT: Option<CommentAuthor> = Some(CommentAuthor::Agent);

    fn thread(id: &str) -> Change {
        Change::Thread(id.into())
    }

    fn at(seq: u64) -> Cursor {
        Cursor { instance: "run".into(), seq }
    }

    #[test]
    fn stays_quiet_on_the_ignored_authors_changes_and_reports_everyone_s() {
        let log = ActivityLog::new("run".into());
        assert_eq!(log.since(&at(0), None), Since::Quiet);
        assert_eq!(log.record([(AGENT, thread("a"))]), Some(at(1)));
        assert_eq!(log.since(&at(0), AGENT), Since::Quiet);
        let threads = BTreeSet::from(["a".to_owned()]);
        assert_eq!(log.since(&at(0), None), Since::Changed { through: at(1), threads, key: false });
        log.record([(None, thread("b")), (None, thread("a"))]);
        let threads = BTreeSet::from(["a".to_owned(), "b".to_owned()]);
        assert_eq!(log.since(&at(0), AGENT), Since::Changed { through: at(3), threads, key: false });
        assert_eq!(log.since(&at(3), AGENT), Since::Quiet);
        log.record([(None, Change::Key)]);
        assert_eq!(log.since(&at(3), AGENT), Since::Changed { through: at(4), threads: BTreeSet::new(), key: true });
        assert_eq!(log.record([]), None);
    }

    #[test]
    fn loses_a_cursor_of_another_run_or_outside_the_window() {
        let log = ActivityLog::new("run".into());
        assert_eq!(log.since(&at(1), None), Since::Lost);
        assert_eq!(log.since(&Cursor { instance: "other".into(), seq: 0 }, None), Since::Lost);
        log.record((0..=CAPACITY).map(|n| (None, thread(&n.to_string()))));
        assert_eq!(log.since(&at(0), None), Since::Lost);
        assert!(matches!(log.since(&at(1), None), Since::Changed { .. }));
    }

    #[test]
    fn parses_what_it_prints() {
        let cursor = Cursor { instance: "a:b".into(), seq: 7 };
        assert_eq!(Cursor::parse(&cursor.to_string()), Some(cursor));
        for bad in ["", "7", ":7", "a:", "a:-1", "a:+1", "a:x"] {
            assert_eq!(Cursor::parse(bad), None, "{bad}");
        }
    }
}
