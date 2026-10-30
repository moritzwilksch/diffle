//! The model's answer made safe to show: only the snapshot's files, each once, the generated ones
//! in a part of their own.
use std::collections::HashSet;

use serde::Deserialize;
use serde_json::Value;

use crate::error::StoryError;
use crate::protocol::{Snapshot, Story, StoryFile, StoryPart};

#[derive(Deserialize)]
struct Answer {
    summary: String,
    parts: Vec<AnswerPart>,
}

#[derive(Deserialize)]
struct AnswerPart {
    title: String,
    narrative: String,
    files: Vec<AnswerFile>,
}

#[derive(Deserialize)]
struct AnswerFile {
    path: String,
    #[serde(default)]
    note: String,
}

/// The title of the part holding what the model left out, and of the one holding the generated files.
pub const LEFTOVER_TITLE: &str = "Other changes";
pub const GENERATED_TITLE: &str = "Generated files";

/// `answer` as the story of `snap`: unknown and repeated paths are dropped, forgotten files form a
/// trailing part, and the generated files always close the story.
pub fn assemble(answer: Value, snap: &Snapshot, model: String, fingerprint: String) -> Result<Story, StoryError> {
    let answer: Answer = serde_json::from_value(answer)
        .map_err(|e| StoryError::upstream(format!("The model's answer is not a story: {e}")))?;
    let generated: HashSet<&str> = snap.changed.iter().filter(|f| f.generated).map(|f| f.path.as_str()).collect();
    let known: HashSet<&str> = snap.changed.iter().map(|f| f.path.as_str()).collect();
    let mut placed: HashSet<String> = HashSet::new();
    let mut parts = Vec::new();
    for part in answer.parts {
        let files: Vec<StoryFile> = part
            .files
            .into_iter()
            .filter(|f| known.contains(f.path.as_str()) && !generated.contains(f.path.as_str()))
            .filter(|f| placed.insert(f.path.clone()))
            .map(|f| StoryFile { path: f.path, note: Some(f.note.trim().to_owned()).filter(|n| !n.is_empty()) })
            .collect();
        if files.is_empty() {
            continue;
        }
        parts.push(StoryPart {
            id: String::new(),
            title: part.title.trim().to_owned(),
            narrative: part.narrative.trim().to_owned(),
            files,
        });
    }
    let leftover: Vec<StoryFile> = snap
        .changed
        .iter()
        .filter(|f| !f.generated && !placed.contains(&f.path))
        .map(|f| StoryFile { path: f.path.clone(), note: None })
        .collect();
    if !leftover.is_empty() {
        parts.push(StoryPart {
            id: String::new(),
            title: LEFTOVER_TITLE.into(),
            narrative: "Files the story did not place; read them on their own.".into(),
            files: leftover,
        });
    }
    let generated_files: Vec<StoryFile> =
        snap.changed.iter().filter(|f| f.generated).map(|f| StoryFile { path: f.path.clone(), note: None }).collect();
    if !generated_files.is_empty() {
        parts.push(StoryPart {
            id: String::new(),
            title: GENERATED_TITLE.into(),
            narrative: "Automatically generated files, hidden by default.".into(),
            files: generated_files,
        });
    }
    for (i, part) in parts.iter_mut().enumerate() {
        part.id = format!("p{}", i + 1);
    }
    let created_at =
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    Ok(Story { fingerprint, summary: answer.summary.trim().to_owned(), parts, model, created_at })
}
