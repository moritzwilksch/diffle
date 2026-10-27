//! `diffle report`: pushing a report into the diffle running for this repository, which announces
//! itself in `<git-dir>/diffle/server.json`.
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};

use super::paint::{cyan, dim};
use crate::error::{Error, Result};
use crate::git::GitRepo;
use crate::persist::write_file_atomic;
use crate::protocol::{ReportAnchor, ReportBlockInput, ReportInput};

/// What `diffle report` does.
#[derive(clap::Subcommand, Debug)]
pub enum ReportAction {
    /// push a report: a markdown file becomes one block, a .json file is a whole report
    #[command(after_help = PUT_HELP)]
    Put {
        /// the markdown or JSON file to push
        #[arg(value_name = "file", value_hint = clap::ValueHint::FilePath)]
        file: PathBuf,
        /// the report's id (default: the file's name); putting an id again replaces it
        #[arg(long, value_name = "id")]
        id: Option<String>,
        /// the report's title (default: the file's first heading, else its name)
        #[arg(long, value_name = "title")]
        title: Option<String>,
        /// where a markdown report points: <path>:<line> or <path>:<start>-<end>
        #[arg(long, value_name = "path:line")]
        anchor: Option<String>,
        /// run as if started in <path> (any directory inside the reviewed repository)
        #[arg(short = 'C', value_name = "path", value_hint = clap::ValueHint::DirPath)]
        dir: Option<PathBuf>,
    },
    /// remove a pushed report
    Delete {
        /// the report's id
        #[arg(value_name = "id")]
        id: String,
        /// run as if started in <path> (any directory inside the reviewed repository)
        #[arg(short = 'C', value_name = "path", value_hint = clap::ValueHint::DirPath)]
        dir: Option<PathBuf>,
    },
}

const PUT_HELP: &str = "\
A .json file is a report as the API takes it:
  { \"title\": \"Dependency review\",
    \"blocks\": [
      { \"kind\": \"markdown\", \"text\": \"...\", \"anchor\": { \"path\": \"pixi.lock\", \"line\": 1 } },
      { \"kind\": \"pages\", \"label\": \"Rendered\",
        \"pages\": [{ \"label\": \"p. 1\", \"old\": \"old/1.png\", \"new\": \"new/1.png\" }] } ] }
The files a pages block names are read relative to the .json file and uploaded first; only
raster images are accepted. An anchor is dropped when the review does not show its path.

Any other file is one markdown block; --anchor says what it is about.

The report shows in the Reports view (gr) and goes stale when the diff moves on. Agents can
push one over HTTP instead: PUT <url>api/reports/<id> with the same JSON; the url is in
<git-dir>/diffle/server.json while diffle runs.";

/// How long the running diffle may take to answer.
const TIMEOUT: Duration = Duration::from_secs(10);

fn announcement(git_dir: &Path) -> PathBuf {
    git_dir.join("diffle").join("server.json")
}

/// Records where this run listens, for `diffle report` and agents. A failure is not the run's.
pub async fn announce(git_dir: &Path, url: &str) {
    let text = json!({ "url": url, "pid": std::process::id() }).to_string() + "\n";
    if let Err(e) = write_file_atomic(&announcement(git_dir), &text).await {
        crate::status!("[diffle] announcing the server: {e:#}");
    }
}

/// Withdraws this run's announcement, unless another run has since made its own.
pub async fn withdraw(git_dir: &Path) {
    let file = announcement(git_dir);
    if let Ok(text) = tokio::fs::read_to_string(&file).await
        && serde_json::from_str::<Value>(&text).ok().and_then(|v| v["pid"].as_u64())
            == Some(u64::from(std::process::id()))
    {
        let _ = tokio::fs::remove_file(&file).await;
    }
}

pub async fn run(action: ReportAction) -> anyhow::Result<()> {
    match action {
        ReportAction::Put { file, id, title, anchor, dir } => put(&file, id, title, anchor, dir).await?,
        ReportAction::Delete { id, dir } => {
            crate::reports::input::check_id(&id)?;
            let (url, client) = connect(dir).await?;
            let res = client.delete(format!("{url}api/reports/{id}")).send().await.map_err(sent)?;
            answered(res).await?;
            crate::status!("{} report {id} removed", dim("✓"));
        }
    }
    Ok(())
}

/// The running server's base url (with its trailing slash) and a client for it.
async fn connect(dir: Option<PathBuf>) -> Result<(String, reqwest::Client)> {
    let cwd = match dir {
        Some(dir) => dir,
        None => std::env::current_dir()?,
    };
    let repo = GitRepo::open(&cwd).await?;
    let not_running =
        || Error::Conflict("no diffle is running for this repository; start one with `diffle working`".into());
    let text = tokio::fs::read_to_string(announcement(&repo.git_dir)).await.map_err(|_| not_running())?;
    let url = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| v["url"].as_str().map(str::to_owned))
        .ok_or_else(not_running)?;
    let client = reqwest::Client::builder().timeout(TIMEOUT).build().map_err(anyhow::Error::from)?;
    // The announcement outlives a crashed run: only an answer proves someone is listening.
    if client.get(format!("{url}api/config")).send().await.is_err() {
        return Err(not_running());
    }
    Ok((url, client))
}

async fn put(
    file: &Path,
    id: Option<String>,
    title: Option<String>,
    anchor: Option<String>,
    dir: Option<PathBuf>,
) -> Result<()> {
    let text = tokio::fs::read_to_string(file)
        .await
        .map_err(|e| Error::Invalid(format!("reading {}: {e}", file.display())))?;
    let stem = file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let id = id.unwrap_or_else(|| id_of(&stem));
    crate::reports::input::check_id(&id)?;
    let (mut report, base) = if file.extension().is_some_and(|e| e.eq_ignore_ascii_case("json")) {
        let report: ReportInput =
            serde_json::from_str(&text).map_err(|e| Error::Invalid(format!("{}: {e}", file.display())))?;
        (report, file.parent().map(Path::to_path_buf))
    } else {
        let anchor = anchor.as_deref().map(parse_anchor).transpose()?;
        let heading = text.lines().map(str::trim).find(|l| !l.is_empty()).map(|l| l.trim_start_matches('#').trim());
        let title = heading.filter(|h| !h.is_empty()).map_or_else(|| stem.clone(), str::to_owned);
        (
            ReportInput {
                title,
                summary: None,
                target: None,
                blocks: vec![ReportBlockInput::Markdown { text, anchor }],
            },
            None,
        )
    };
    if let Some(title) = title {
        report.title = title;
    }
    let (url, client) = connect(dir).await?;
    for name in named_files(&report) {
        let path = base.clone().unwrap_or_default().join(&name);
        let bytes =
            tokio::fs::read(&path).await.map_err(|e| Error::Invalid(format!("reading {}: {e}", path.display())))?;
        let res = client.put(format!("{url}api/reports/{id}/files/{name}")).body(bytes).send().await.map_err(sent)?;
        answered(res).await?;
    }
    let res = client.put(format!("{url}api/reports/{id}")).json(&report).send().await.map_err(sent)?;
    let created = res.status() == reqwest::StatusCode::CREATED;
    let report = answered(res).await?;
    crate::status!(
        "{} report {} {} {}",
        dim("✓"),
        report["title"].as_str().unwrap_or(&id),
        if created { "added" } else { "replaced" },
        dim(&format!("({id}, {url})"))
    );
    crate::status!("   {}", cyan(&format!("{url}#reports")));
    Ok(())
}

/// A request that got no answer: the server went away mid-way, which the user can fix.
fn sent(e: reqwest::Error) -> Error {
    Error::Conflict(format!("the running diffle did not answer: {e}"))
}

/// The response's JSON, or its `error` as a user error.
async fn answered(res: reqwest::Response) -> Result<Value> {
    let status = res.status();
    let text = res.text().await.map_err(anyhow::Error::from)?;
    let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if status.is_success() {
        return Ok(value);
    }
    let message = value["error"].as_str().map_or_else(|| format!("{status}: {text}"), str::to_owned);
    Err(if status == reqwest::StatusCode::CONFLICT { Error::Conflict(message) } else { Error::Invalid(message) })
}

/// A file name as a report id: lowercased, anything else a dash, at most 64 long.
fn id_of(stem: &str) -> String {
    let mut id = String::new();
    for c in stem.to_lowercase().chars() {
        let keep = c.is_ascii_lowercase() || c.is_ascii_digit();
        if keep {
            id.push(c);
        } else if !id.ends_with('-') && !id.is_empty() {
            id.push('-');
        }
    }
    let id = id.trim_end_matches('-');
    id.chars().take(64).collect::<String>().trim_end_matches('-').to_owned()
}

/// `path:line` or `path:start-end`.
fn parse_anchor(raw: &str) -> Result<ReportAnchor> {
    let invalid = || Error::Invalid(format!("--anchor: expected <path>:<line> or <path>:<start>-<end>, got \"{raw}\""));
    let (path, lines) = raw.rsplit_once(':').ok_or_else(invalid)?;
    let (start, end) = match lines.split_once('-') {
        Some((a, b)) => (a, Some(b)),
        None => (lines, None),
    };
    let line = start.parse::<i64>().ok().filter(|n| *n > 0).ok_or_else(invalid)?;
    let end_line = end.map(|e| e.parse::<i64>().ok().filter(|n| *n >= line).ok_or_else(invalid)).transpose()?;
    if path.is_empty() {
        return Err(invalid());
    }
    Ok(ReportAnchor { path: path.to_owned(), side: None, line, end_line })
}

fn named_files(report: &ReportInput) -> Vec<String> {
    let mut names: Vec<String> = report
        .blocks
        .iter()
        .flat_map(|b| match b {
            ReportBlockInput::Pages { pages, .. } => {
                pages.iter().flat_map(|p| p.old.iter().chain(p.new.iter()).cloned()).collect()
            }
            ReportBlockInput::Markdown { .. } => Vec::new(),
        })
        .collect();
    names.sort();
    names.dedup();
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_ids_and_parses_anchors() {
        assert_eq!(id_of("Review Notes (v2)"), "review-notes-v2");
        assert_eq!(id_of("--"), "");
        assert_eq!(id_of(&"a".repeat(70)).len(), 64);
        let a = parse_anchor("src/a.rs:12-14").unwrap();
        assert_eq!((a.path.as_str(), a.line, a.end_line), ("src/a.rs", 12, Some(14)));
        let a = parse_anchor("C:/x/y.txt:3").unwrap();
        assert_eq!((a.path.as_str(), a.line, a.end_line), ("C:/x/y.txt", 3, None));
        for bad in ["a.rs", "a.rs:0", "a.rs:5-3", ":3", "a.rs:x"] {
            assert!(parse_anchor(bad).is_err(), "{bad}");
        }
    }
}
