//! Reference queries, bounded, and the one patient retry for answers a server gave while indexing.
use std::time::Duration;

use super::assemble::SymbolKey;
use super::limits::Deadline;
use super::source::SymbolSource;
use crate::concurrency::map_limit;
use crate::error::{Error, Result};
use crate::protocol::{LspLocation, LspPosition};

/// Reference queries in flight at once.
pub const MAX_IN_FLIGHT: usize = 8;

/// How long to wait for the servers to go quiet, and how often to look.
pub struct Patience {
    pub poll: Duration,
    pub limit: Duration,
}

impl Patience {
    pub const DEFAULT: Self = Self { poll: Duration::from_millis(100), limit: Duration::from_secs(20) };
}

/// A changed symbol and where to ask for its references.
#[derive(Clone)]
pub struct Subject {
    pub key: SymbolKey,
    pub at: LspPosition,
}

pub enum Answer {
    Found(Vec<LspLocation>),
    /// Empty while a server was still indexing: it may know better later.
    Inconclusive,
    /// No server could be asked; the message says why.
    Failed(String),
    /// The query went wrong in a way that says nothing about the others: a timeout, a refusal.
    Errored,
    /// The build's deadline came before the query did.
    Unfinished,
}

/// Whether a query's error ends the build, as opposed to costing that one answer. Only a failed
/// git call does: the snapshot itself cannot be trusted then.
pub fn is_fatal(error: &Error) -> bool {
    matches!(error, Error::Git(_))
}

/// What `settle` leaves: the answers, and whether some were still inconclusive after the retry.
pub struct Settled {
    pub answers: Vec<Answer>,
    pub indexing: bool,
}

/// Asks the references of each subject, `MAX_IN_FLIGHT` at a time; answers keep the input order.
pub async fn ask<S: SymbolSource>(source: &S, deadline: &Deadline, subjects: &[&Subject]) -> Result<Vec<Answer>> {
    // Owned subjects: a borrowed one makes the future too lifetime-generic to be spawned.
    let owned: Vec<Subject> = subjects.iter().map(|s| (*s).clone()).collect();
    let answers = map_limit(owned, MAX_IN_FLIGHT, |s| async move { answer(source, deadline, &s).await }).await;
    answers.into_iter().collect()
}

async fn answer<S: SymbolSource>(source: &S, deadline: &Deadline, subject: &Subject) -> Result<Answer> {
    let Some(reply) = deadline.within(source.references(&subject.at)).await else { return Ok(Answer::Unfinished) };
    match reply {
        Ok(r) if r.inconclusive.is_some() => Ok(Answer::Inconclusive),
        Ok(r) => Ok(Answer::Found(r.locations)),
        // One symbol the servers cannot answer for must not sink the graph of the others.
        Err(Error::LspUnavailable(why) | Error::LspUnsupported(why)) => Ok(Answer::Failed(why)),
        Err(e) if is_fatal(&e) => Err(e),
        Err(_) => Ok(Answer::Errored),
    }
}

/// Waits for the servers to go quiet (at most `patience.limit`), then asks once more the subjects
/// whose answer was inconclusive. Answers still inconclusive then are reported, not retried.
pub async fn settle<S: SymbolSource>(
    source: &S,
    patience: &Patience,
    deadline: &Deadline,
    subjects: &[Subject],
    mut answers: Vec<Answer>,
) -> Result<Settled> {
    let pending: Vec<usize> =
        answers.iter().enumerate().filter(|(_, a)| matches!(a, Answer::Inconclusive)).map(|(i, _)| i).collect();
    if pending.is_empty() {
        return Ok(Settled { answers, indexing: false });
    }
    quiet(source, patience, deadline).await;
    let again: Vec<&Subject> = pending.iter().map(|&i| &subjects[i]).collect();
    for (i, fresh) in pending.into_iter().zip(ask(source, deadline, &again).await?) {
        answers[i] = fresh;
    }
    let indexing = answers.iter().any(|a| matches!(a, Answer::Inconclusive));
    Ok(Settled { answers, indexing })
}

/// Returns when no server reports work, or when the patience or the build's deadline is up.
pub async fn quiet<S: SymbolSource>(source: &S, patience: &Patience, deadline: &Deadline) {
    let until = (tokio::time::Instant::now() + patience.limit).min(deadline.at());
    while source.busy() && tokio::time::Instant::now() < until {
        tokio::time::sleep(patience.poll).await;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::Ordering;

    use super::*;
    use crate::graph::source::fake::{Fake, Reply, loc};

    fn open() -> Deadline {
        Deadline::new(Duration::from_secs(60))
    }

    const QUICK: Patience = Patience { poll: Duration::from_millis(1), limit: Duration::from_millis(200) };

    fn subject(path: &str, line: u64) -> Subject {
        Subject {
            key: SymbolKey { path: path.into(), line: line as u32, name: "f".into(), kind: 12 },
            at: LspPosition { col: 4, line: line.try_into().unwrap(), path: path.parse().unwrap() },
        }
    }

    fn found(answer: &Answer) -> Vec<(String, u64)> {
        match answer {
            Answer::Found(locations) => locations.iter().map(|l| (l.path.to_string(), l.line.get())).collect(),
            Answer::Inconclusive | Answer::Failed(_) | Answer::Errored | Answer::Unfinished => Vec::new(),
        }
    }

    #[tokio::test]
    async fn a_retry_recovers_an_inconclusive_answer_and_asks_only_that_subject() {
        let source = Fake::default()
            .replies("a.py", 1, vec![Reply::Inconclusive, Reply::Found(vec![loc("c.py", 9)])])
            .replies("b.py", 2, vec![Reply::Found(vec![loc("c.py", 5)])]);
        let subjects = [subject("a.py", 1), subject("b.py", 2)];
        let first = ask(&source, &open(), &subjects.iter().collect::<Vec<_>>()).await.unwrap();
        assert!(matches!(first[0], Answer::Inconclusive));
        let settled = settle(&source, &QUICK, &open(), &subjects, first).await.unwrap();
        assert_eq!(
            (found(&settled.answers[0]), found(&settled.answers[1]), settled.indexing),
            (vec![("c.py".to_owned(), 9)], vec![("c.py".to_owned(), 5)], false)
        );
        assert_eq!((source.asked_at("a.py", 1), source.asked_at("b.py", 2)), (2, 1));
    }

    #[tokio::test]
    async fn an_answer_still_inconclusive_after_the_retry_is_reported_and_not_asked_a_third_time() {
        let source = Fake::default().replies("a.py", 1, vec![Reply::Inconclusive, Reply::Inconclusive]);
        let subjects = [subject("a.py", 1)];
        let first = ask(&source, &open(), &subjects.iter().collect::<Vec<_>>()).await.unwrap();
        let settled = settle(&source, &QUICK, &open(), &subjects, first).await.unwrap();
        assert!(settled.indexing);
        assert!(matches!(settled.answers[0], Answer::Inconclusive));
        assert_eq!(source.asked_at("a.py", 1), 2);
    }

    #[tokio::test]
    async fn conclusive_answers_neither_wait_nor_retry() {
        let source = Fake::default();
        source.busy_for.store(5, Ordering::SeqCst);
        let subjects = [subject("a.py", 1)];
        let first = ask(&source, &open(), &subjects.iter().collect::<Vec<_>>()).await.unwrap();
        let settled = settle(&source, &QUICK, &open(), &subjects, first).await.unwrap();
        assert_eq!((settled.indexing, source.asked_at("a.py", 1), source.polls.load(Ordering::SeqCst)), (false, 1, 0));
    }

    #[tokio::test]
    async fn the_retry_waits_until_the_servers_go_quiet() {
        let source = Fake::default().replies("a.py", 1, vec![Reply::Inconclusive]);
        source.busy_for.store(3, Ordering::SeqCst);
        let subjects = [subject("a.py", 1)];
        let first = ask(&source, &open(), &subjects.iter().collect::<Vec<_>>()).await.unwrap();
        settle(&source, &QUICK, &open(), &subjects, first).await.unwrap();
        // Busy three times, quiet on the fourth look; the retry came after.
        assert_eq!(source.polls.load(Ordering::SeqCst), 4);
        assert_eq!(source.asked_at("a.py", 1), 2);
    }

    #[tokio::test]
    async fn the_wait_gives_up_at_the_limit_when_the_servers_never_go_quiet() {
        let source = Fake::default().replies("a.py", 1, vec![Reply::Inconclusive, Reply::Inconclusive]);
        source.busy_for.store(usize::MAX, Ordering::SeqCst);
        let patience = Patience { poll: Duration::from_millis(5), limit: Duration::from_millis(40) };
        let subjects = [subject("a.py", 1)];
        let first = ask(&source, &open(), &subjects.iter().collect::<Vec<_>>()).await.unwrap();
        let started = std::time::Instant::now();
        let settled = settle(&source, &patience, &open(), &subjects, first).await.unwrap();
        assert!(started.elapsed() < Duration::from_secs(2), "waited {:?}", started.elapsed());
        assert_eq!((settled.indexing, source.asked_at("a.py", 1)), (true, 2));
    }

    #[tokio::test]
    async fn a_failed_query_is_an_answer_not_an_error() {
        let source = Fake::default().replies("a.py", 1, vec![Reply::Unavailable("pyrefly crashed")]);
        let subjects = [subject("a.py", 1)];
        let answers = ask(&source, &open(), &subjects.iter().collect::<Vec<_>>()).await.unwrap();
        assert!(matches!(&answers[0], Answer::Failed(m) if m == "pyrefly crashed"));
    }

    #[tokio::test]
    async fn a_timeout_costs_that_answer_and_nothing_else() {
        let timeout = Error::Other(std::sync::Arc::new(anyhow::anyhow!("timed out")));
        let source = Fake::default().replies("a.py", 1, vec![Reply::Fail(timeout)]);
        let subjects = [subject("a.py", 1), subject("b.py", 2)];
        let answers = ask(&source, &open(), &subjects.iter().collect::<Vec<_>>()).await.unwrap();
        assert!(matches!(answers[0], Answer::Errored));
        assert!(matches!(answers[1], Answer::Found(_)));
    }

    #[tokio::test]
    async fn a_failed_git_call_is_fatal() {
        let git = Error::Git(crate::error::GitError::refused("boom", &["diff"]));
        let source = Fake::default().replies("a.py", 1, vec![Reply::Fail(git)]);
        let subjects = [subject("a.py", 1)];
        assert!(ask(&source, &open(), &subjects.iter().collect::<Vec<_>>()).await.is_err());
    }

    #[tokio::test]
    async fn queries_cut_by_the_deadline_are_unfinished_not_failed() {
        let source = Fake { delay: Duration::from_secs(30), ..Fake::default() };
        let deadline = Deadline::new(Duration::from_millis(20));
        let subjects = [subject("a.py", 1)];
        let answers = ask(&source, &deadline, &subjects.iter().collect::<Vec<_>>()).await.unwrap();
        assert!(matches!(answers[0], Answer::Unfinished) && deadline.was_hit());
    }

    #[tokio::test]
    async fn the_wait_for_quiet_ends_at_the_deadline_whatever_the_patience() {
        let source = Fake::default();
        source.busy_for.store(usize::MAX, Ordering::SeqCst);
        let patience = Patience { poll: Duration::from_millis(5), limit: Duration::from_secs(60) };
        let started = std::time::Instant::now();
        quiet(&source, &patience, &Deadline::new(Duration::from_millis(40))).await;
        assert!(started.elapsed() < Duration::from_secs(5), "waited {:?}", started.elapsed());
    }
}
