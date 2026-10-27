//! Running one generator for one snapshot: copies of the sides in a temporary folder, the program
//! started on them with the review on stdin, and what it wrote read back as a report.
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use super::catalog::{Plugin, Scope};
use super::exec::{Vars, pipeline, stages_of};
use super::input::{self, safe_relative};
use super::sides::materialize;
use super::store::ReportStore;
use crate::error::{Error, Result};
use crate::protocol::{
    ChangeStatus, ChangedFile, ReportAnchor, ReportBlock, ReportFile, ReportInput, ReportTarget, Side, Snapshot,
};
use crate::session::Session;

/// How long one generator may take for one snapshot.
pub const RUN_TIMEOUT: Duration = Duration::from_secs(600);
pub(super) const FILE_VAR: &str = "DIFFLE_FILE";

/// What a run made: a report's parts and the files it named, already stored.
pub struct Produced {
    pub title: String,
    pub summary: String,
    pub blocks: Vec<ReportBlock>,
    pub files: HashMap<String, ReportFile>,
    pub log: Vec<String>,
}

/// Why a run made no report, with what the program said on the way.
#[derive(Debug)]
pub struct Failure {
    pub message: String,
    pub log: Vec<String>,
}

impl From<Error> for Failure {
    fn from(e: Error) -> Self {
        Self { message: e.to_string(), log: Vec::new() }
    }
}

impl From<std::io::Error> for Failure {
    fn from(e: std::io::Error) -> Self {
        Self { message: e.to_string(), log: Vec::new() }
    }
}

pub(super) fn failed(message: impl Into<String>) -> Error {
    Error::Invalid(message.into())
}

/// Runs `plugin` for `snap`, whose changed files `matched` are the ones its globs chose.
pub async fn run(
    session: &Arc<Session>,
    store: &ReportStore,
    snap: &Arc<Snapshot>,
    target: &ReportTarget,
    plugin: &Plugin,
    matched: &[String],
) -> Result<Produced, Failure> {
    let stages = stages_of(&plugin.command)?;
    let dir = tempfile::Builder::new().prefix("diffle-report-").tempdir()?;
    let (old, new, out) = (dir.path().join("old"), dir.path().join("new"), dir.path().join("out"));
    materialize(session, snap, plugin.scope, matched, &old, &new).await?;
    let per_file =
        plugin.command.contains(&format!("${FILE_VAR}")) || plugin.command.contains(&format!("${{{FILE_VAR}}}"));
    let runs: Vec<Option<String>> = if per_file { matched.iter().cloned().map(Some).collect() } else { vec![None] };
    let mut produced = Produced {
        title: plugin.name.clone(),
        summary: String::new(),
        blocks: Vec::new(),
        files: HashMap::new(),
        log: Vec::new(),
    };
    let changed: Vec<&ChangedFile> = snap.changed.iter().filter(|f| matched.contains(&f.path)).collect();
    for (n, file) in runs.iter().enumerate() {
        let run_out = out.join(n.to_string());
        tokio::fs::create_dir_all(&run_out).await?;
        let vars = Vars {
            root: snap.root.clone(),
            old: old.clone(),
            new: new.clone(),
            out: run_out.clone(),
            file: file.clone(),
        };
        let stdin = json!({
            "version": 1,
            "review": snap.review,
            "target": target,
            "root": vars.root,
            "old": vars.old,
            "new": vars.new,
            "out": vars.out,
            "file": file,
            "files": changed.iter().map(|f| json!({ "path": f.path, "oldPath": f.old_path, "status": f.status })).collect::<Vec<_>>(),
            "scope": if plugin.scope == Scope::Tree { "tree" } else { "changed" },
        });
        let output =
            match tokio::time::timeout(RUN_TIMEOUT, pipeline(&stages, &vars, stdin.to_string().into_bytes())).await {
                Ok(Ok(output)) => output,
                Ok(Err(mut failure)) => {
                    produced.log.append(&mut failure.log);
                    return Err(Failure { message: failure.message, log: produced.log });
                }
                Err(_) => {
                    return Err(Failure {
                        message: format!("timed out after {}s", RUN_TIMEOUT.as_secs()),
                        log: produced.log,
                    });
                }
            };
        produced.log.extend(output.log);
        let (anchor, heading) = match file.as_deref().and_then(|f| changed.iter().find(|c| c.path == f)) {
            Some(f) => {
                let side = if f.status == ChangeStatus::D { Side::Old } else { Side::New };
                (
                    Some(ReportAnchor { path: f.path.clone(), side: Some(side), line: 1, end_line: None }),
                    Some(f.path.clone()),
                )
            }
            None => (None, None),
        };
        if let Err(e) = collect(session, store, snap, &run_out, output.stdout, anchor, heading, &mut produced).await {
            return Err(Failure { message: e.to_string(), log: produced.log });
        }
    }
    if produced.blocks.is_empty() {
        return Err(Failure {
            message: "the program wrote neither a report.json nor anything to stdout".into(),
            log: produced.log,
        });
    }
    if produced.summary.is_empty() {
        produced.summary = produced
            .blocks
            .iter()
            .find_map(|b| match b {
                ReportBlock::Markdown { text, .. } => text
                    .lines()
                    .map(str::trim)
                    .find(|l| !l.is_empty())
                    .map(|l| l.trim_start_matches('#').trim().to_owned()),
                ReportBlock::Pages { .. } => None,
            })
            .unwrap_or_default();
    }
    Ok(produced)
}

/// Reads one run's output: `report.json` with its files, else stdout as one markdown block.
#[allow(clippy::too_many_arguments)]
async fn collect(
    session: &Arc<Session>,
    store: &ReportStore,
    snap: &Arc<Snapshot>,
    out: &Path,
    stdout: Vec<u8>,
    anchor: Option<ReportAnchor>,
    heading: Option<String>,
    produced: &mut Produced,
) -> Result<()> {
    let report_file = out.join("report.json");
    let Ok(text) = tokio::fs::read_to_string(&report_file).await else {
        let text = String::from_utf8_lossy(&stdout).trim().to_owned();
        if !text.is_empty() {
            let text = match heading {
                Some(path) => format!("### {path}\n\n{text}"),
                None => text,
            };
            produced.blocks.push(ReportBlock::Markdown { text, anchor });
        }
        return Ok(());
    };
    let report: ReportInput = serde_json::from_str(&text).map_err(|e| failed(format!("report.json: {e}")))?;
    let mut files = HashMap::new();
    for path in named_files(&report) {
        if !safe_relative(&path) {
            return Err(failed(format!(
                "report.json names \"{path}\": a relative path under the output folder is expected"
            )));
        }
        let bytes =
            tokio::fs::read(out.join(&path)).await.map_err(|e| failed(format!("report.json names \"{path}\": {e}")))?;
        let file = store.put_blob(&bytes).await.map_err(|e| failed(format!("\"{path}\": {e}")))?;
        files.insert(path, file);
    }
    let shown = |path: &str, side: Side| -> bool { session.has_side(snap, path, side) };
    let valid = input::validate(report, &files, shown)?;
    if produced.blocks.is_empty() {
        produced.title = valid.title;
        produced.summary = valid.summary;
    }
    produced.blocks.extend(valid.blocks);
    produced.files.extend(files);
    produced.log.extend(valid.notes);
    Ok(())
}

fn named_files(report: &ReportInput) -> Vec<String> {
    use crate::protocol::ReportBlockInput;
    let mut names = Vec::new();
    for block in &report.blocks {
        if let ReportBlockInput::Pages { pages, .. } = block {
            for page in pages {
                names.extend(page.old.iter().chain(page.new.iter()).cloned());
            }
        }
    }
    names.sort();
    names.dedup();
    names
}
