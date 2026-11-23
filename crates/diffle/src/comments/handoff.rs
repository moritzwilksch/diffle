//! Feedback and its exact reply target, stored atomically with the thread it belongs to.
use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

use super::store::{CommentStore, SetData, find_thread, new_message};
use crate::error::{Error, Result};
use crate::protocol::TourCheckItem;
use crate::protocol::{CommentAuthor, CommentMessage, CommentThread, FeedbackItem, ReviewEvidence};
use std::fmt::Write as _;

/// Adds current reply targets or historical evidence to the exported review.
pub fn format_followup(
    threads: &[CommentThread],
    checks: &[TourCheckItem],
    pending: &[FeedbackItem],
    live: bool,
) -> String {
    let mut prompt = super::format::format_prompt(threads, checks);
    let items: Vec<_> = pending
        .iter()
        .filter(|item| {
            threads.iter().any(|thread| {
                thread.id == item.thread_id && thread.messages.iter().any(|message| message.id == item.message_id)
            })
        })
        .collect();
    if items.is_empty() {
        return prompt;
    }
    if live {
        prompt.push_str("\n## Pending feedback in Diffle\n\nRun `diffle comments context <target>` immediately before addressing each item. Verify the fix and send a short summary with `diffle comments reply <target> <summary>`. Leave blocked items pending.\n");
    } else {
        prompt.push_str("\n## Saved feedback context\n\nThese excerpts are historical. Verify the current location before editing.\n");
    }
    for item in items {
        let _ = writeln!(prompt, "\n{}", item.feedback.trim());
        if live {
            let _ = writeln!(prompt, "\nTarget: `{}`", item.target);
        }
        if let Some(original) = &item.original {
            write_evidence(&mut prompt, original);
        }
    }
    prompt
}

fn write_evidence(prompt: &mut String, original: &ReviewEvidence) {
    let _ = writeln!(
        prompt,
        "\nOriginal ({:?} side) {}:{}–{}",
        original.side, original.path, original.start_line, original.end_line
    );
    for line in &original.before {
        let _ = writeln!(prompt, "> {}: {}{}", line.line, line.text, if line.truncated { "…" } else { "" });
    }
    for (index, text) in original.excerpt.split('\n').enumerate() {
        let _ = writeln!(prompt, "> {}: {text}", original.start_line + index as i64);
    }
    if original.excerpt_truncated {
        prompt.push_str("> …\n");
    }
    for line in &original.after {
        let _ = writeln!(prompt, "> {}: {}{}", line.line, line.text, if line.truncated { "…" } else { "" });
    }
}

#[derive(Default, Deserialize, Serialize)]
pub(super) struct FeedbackData {
    #[serde(default)]
    pub(super) originals: BTreeMap<String, ReviewEvidence>,
    #[serde(default)]
    answers: BTreeMap<String, Answer>,
}

#[derive(Deserialize, Serialize)]
struct Answer {
    revision: i64,
    reply: String,
}

impl FeedbackData {
    pub(super) fn is_empty(&self) -> bool {
        self.originals.is_empty() && self.answers.is_empty()
    }

    pub(super) fn retain(&mut self, threads: &[CommentThread]) {
        if self.is_empty() {
            return;
        }
        let ids: HashSet<_> =
            threads.iter().flat_map(|thread| thread.messages.iter().map(|message| &message.id)).collect();
        self.originals.retain(|id, _| ids.contains(id));
        self.answers.retain(|id, answer| ids.contains(id) && ids.contains(&answer.reply));
    }

    fn answered(&self, message: &CommentMessage) -> bool {
        self.answers.get(&message.id).is_some_and(|answer| answer.revision == message.updated_at)
    }

    fn item(&self, scope: &str, thread: &CommentThread, message: &CommentMessage) -> FeedbackItem {
        FeedbackItem {
            target: format!("{scope}.{}.{}.{}", thread.id, message.id, message.updated_at),
            thread_id: thread.id.clone(),
            message_id: message.id.clone(),
            anchor: thread.anchor.clone(),
            feedback: message.body.clone(),
            original: self.originals.get(&message.id).cloned().or_else(|| ReviewEvidence::from_anchor(&thread.anchor)),
        }
    }
}

struct Target<'a> {
    thread: &'a str,
    message: &'a str,
    revision: i64,
}

impl<'a> Target<'a> {
    fn parse(target: &'a str, scope: &str) -> Result<Self> {
        let mut fields = target.split('.');
        if fields.next() == Some(scope)
            && let (Some(thread), Some(message), Some(revision), None) =
                (fields.next(), fields.next(), fields.next(), fields.next())
            && let Ok(revision) = revision.parse()
        {
            return Ok(Self { thread, message, revision });
        }
        Err(Error::Invalid(
            "feedback target is invalid for the active review; run diffle comments pending again".into(),
        ))
    }

    fn message<'b>(&self, thread: &'b CommentThread) -> Result<&'b CommentMessage> {
        thread
            .messages
            .iter()
            .find(|m| m.id == self.message && m.author.is_none() && m.updated_at == self.revision)
            .ok_or_else(|| Error::Invalid("feedback changed or was removed; run diffle comments pending again".into()))
    }
}

impl CommentStore {
    pub async fn pending(&self, scope: &str) -> Result<Vec<FeedbackItem>> {
        let set = self.read().await?;
        let mut pending: Vec<_> = set
            .threads
            .iter()
            .filter(|t| !t.resolved)
            .flat_map(|t| {
                t.messages.iter().filter(|m| m.author.is_none() && !set.feedback.answered(m)).map(move |m| (t, m))
            })
            .collect();
        pending.sort_by_key(|(_, message)| (message.created_at, &message.id));
        Ok(pending.into_iter().map(|(thread, message)| set.feedback.item(scope, thread, message)).collect())
    }

    pub async fn feedback_item(&self, scope: &str, target: &str) -> Result<FeedbackItem> {
        let target = Target::parse(target, scope)?;
        let mut set = self.read().await?;
        let thread = find_thread(&mut set, target.thread)?.clone();
        let message = target.message(&thread)?;
        if thread.resolved || set.feedback.answered(message) {
            return Err(Error::Invalid("feedback is no longer pending".into()));
        }
        Ok(set.feedback.item(scope, &thread, message))
    }

    /// Returns the saved thread and whether it added a reply.
    pub async fn answer(&self, scope: &str, target: &str, summary: String) -> Result<(CommentThread, bool)> {
        let target = Target::parse(target, scope)?;
        let summary = summary.trim();
        if summary.is_empty() || summary.chars().count() > 1500 {
            return Err(Error::Invalid("provide a reply of 1–1500 characters".into()));
        }
        self.mutate(|set| {
            let SetData { threads, feedback, .. } = set;
            let thread = threads
                .iter_mut()
                .find(|t| t.id == target.thread)
                .ok_or_else(|| Error::NotFound(target.thread.into()))?;
            let message = target.message(thread)?;
            if feedback.answered(message) {
                return Ok(((thread.clone(), false), false));
            }
            if thread.resolved {
                return Err(Error::Invalid("feedback is already resolved".into()));
            }
            let reply = new_message(summary.into(), Some(CommentAuthor::Agent));
            feedback
                .answers
                .insert(target.message.into(), Answer { revision: target.revision, reply: reply.id.clone() });
            thread.messages.push(reply);
            Ok(((thread.clone(), true), true))
        })
        .await
    }

    pub async fn follow_up(
        &self,
        thread_id: &str,
        body: String,
        evidence: Option<ReviewEvidence>,
    ) -> Result<CommentThread> {
        self.mutate(|set| {
            let thread = find_thread(set, thread_id)?;
            let evidence = evidence.or_else(|| ReviewEvidence::from_anchor(&thread.anchor));
            let message = new_message(body, None);
            if let Some(evidence) = evidence {
                set.feedback.originals.insert(message.id.clone(), evidence);
            }
            // Capture the thread first so the message and its evidence are written together.
            let thread = find_thread(set, thread_id)?;
            thread.resolved = false;
            thread.resolved_at = None;
            thread.messages.push(message);
            Ok((thread.clone(), true))
        })
        .await
    }
}
