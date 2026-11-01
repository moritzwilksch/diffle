//! What the model reads: the instructions, the comparison with its commits and files, and the
//! patches within a size budget; and the shape its answer must take.
use serde_json::{Value, json};

use super::client::ModelRequest;
use crate::protocol::{ChangeStatus, Snapshot, comparison_label};

/// A patch longer than this keeps its first lines only: the model groups files, it need not read every hunk.
const PATCH_LINES: usize = 400;
/// Patches past this budget are left out; the file list still names their files.
const PATCH_BUDGET: usize = 400_000;

const SYSTEM: &str = "\
You write the story of a code review: you group the changed files into parts a reader follows in \
order, and explain each part in a couple of sentences.

Rules:
- Order the parts as a story: the motivation and the core change first, then what it drags along \
(callers, tests, docs, configuration, generated output).
- Use between one and six parts. A part holds files that belong together; a file appears in exactly \
one part. List every changed file once, except the files marked generated: leave those out, the \
reviewer hides them.
- Within a part, order the files as the reader should read them.
- A title is a few words, like a commit subject without a type prefix.
- A narrative is two or three sentences on what the part does and why. Do not restate the diff \
line by line, and do not praise or judge.
- A file note is one short sentence on what the file contributes to its part, or an empty string \
when the title already says it.
- The summary is two or three sentences on the whole change, for a reader who has not seen it.
- Write in plain English, in the present tense, without markdown.";

/// The schema the model's answer is constrained to; `assemble` turns it into a `Story`.
pub fn answer_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["summary", "parts"],
        "properties": {
            "summary": { "type": "string" },
            "parts": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["title", "narrative", "files"],
                    "properties": {
                        "title": { "type": "string" },
                        "narrative": { "type": "string" },
                        "files": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "additionalProperties": false,
                                "required": ["path", "note"],
                                "properties": { "path": { "type": "string" }, "note": { "type": "string" } }
                            }
                        }
                    }
                }
            }
        }
    })
}

/// The request for `snap`'s story, with `patches` as `git diff` printed them for its files.
pub fn build(snap: &Snapshot, patches: &str) -> ModelRequest {
    let mut user = format!("# Comparison\n{}\n", comparison_label(&snap.review));
    if !snap.commits.list.is_empty() {
        user.push_str("\n# Commits, oldest first\n");
        for c in &snap.commits.list {
            user.push_str(&format!("- {} {}\n", c.short, indented(c.message.trim())));
        }
        if snap.commits.total > snap.commits.list.len() as i64 {
            user.push_str(&format!(
                "({} earlier commits not listed)\n",
                snap.commits.total - snap.commits.list.len() as i64
            ));
        }
    }
    user.push_str("\n# Changed files\n");
    for f in &snap.changed {
        let status = match f.status {
            ChangeStatus::A => "added",
            ChangeStatus::M => "modified",
            ChangeStatus::D => "deleted",
            ChangeStatus::R => "renamed",
            ChangeStatus::C => "copied",
            ChangeStatus::T => "type changed",
            ChangeStatus::U => "unmerged",
        };
        let mut line = format!("- {} ({status}, +{} -{}", f.path, f.additions, f.deletions);
        if let Some(old) = &f.old_path {
            line.push_str(&format!(", from {old}"));
        }
        if f.generated {
            line.push_str(", generated");
        }
        if f.binary {
            line.push_str(", binary");
        }
        line.push_str(")\n");
        user.push_str(&line);
    }
    user.push_str("\n# Patches\n");
    user.push_str(&budgeted(patches));
    ModelRequest { system: SYSTEM.to_owned(), user, schema: answer_schema() }
}

/// A commit message with its body lines indented under the subject.
fn indented(message: &str) -> String {
    let mut lines = message.lines();
    let mut out = lines.next().unwrap_or_default().to_owned();
    for line in lines {
        out.push_str("\n  ");
        out.push_str(line);
    }
    out
}

/// `patches` split per file, each cut to `PATCH_LINES`, the whole cut to `PATCH_BUDGET`.
pub fn budgeted(patches: &str) -> String {
    let mut out = String::new();
    let mut omitted = 0;
    for chunk in split_patches(patches) {
        let cut = cut_lines(chunk);
        if out.len() + cut.len() > PATCH_BUDGET {
            omitted += 1;
            continue;
        }
        out.push_str(&cut);
    }
    if omitted > 0 {
        out.push_str(&format!("\n({omitted} patches left out for size; their files are listed above)\n"));
    }
    out
}

/// One chunk per `diff --git` header, each starting with it.
fn split_patches(patches: &str) -> Vec<&str> {
    let mut starts: Vec<usize> = patches
        .match_indices("diff --git ")
        .filter(|(i, _)| *i == 0 || patches.as_bytes()[i - 1] == b'\n')
        .map(|(i, _)| i)
        .collect();
    if starts.is_empty() && !patches.trim().is_empty() {
        return vec![patches];
    }
    starts.push(patches.len());
    starts.windows(2).map(|w| &patches[w[0]..w[1]]).collect()
}

fn cut_lines(chunk: &str) -> String {
    let total = chunk.lines().count();
    if total <= PATCH_LINES {
        return chunk.to_owned();
    }
    let mut out: String = chunk.lines().take(PATCH_LINES).collect::<Vec<_>>().join("\n");
    out.push_str(&format!("\n(… {} more lines of this patch not shown)\n", total - PATCH_LINES));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_patches_at_file_headers() {
        let text = "diff --git a/x b/x\n+1\ndiff --git a/y b/y\n+2\n";
        assert_eq!(split_patches(text), ["diff --git a/x b/x\n+1\n", "diff --git a/y b/y\n+2\n"]);
        assert!(split_patches("").is_empty());
    }

    #[test]
    fn cuts_long_patches() {
        let long: String = (0..PATCH_LINES + 5).map(|i| format!("+{i}\n")).collect();
        let cut = cut_lines(&format!("diff --git a/x b/x\n{long}"));
        assert_eq!(cut.lines().count(), PATCH_LINES + 1);
        assert!(cut.ends_with("(… 6 more lines of this patch not shown)\n"));
    }
}
