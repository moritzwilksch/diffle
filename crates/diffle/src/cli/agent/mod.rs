//! `diffle comments` and `diffle tour`: an agent's client of the diffle serving its repository.
//! Every subcommand that answers prints one JSON document on stdout.
mod comments;
mod server;
mod tour;

use std::io::{Read, Write};
use std::path::PathBuf;

use serde::Serialize;

use super::args::{CommentsCommand, RepoOpts, TourCommand};
use crate::error::Error;
use crate::git::GitRepo;
use server::{Diffle, reach};

/// Runs `command`; `dir` is a `-C` given before `comments`, which one after it overrides.
pub async fn comments(command: CommentsCommand, dir: Option<PathBuf>) -> anyhow::Result<()> {
    match command {
        CommentsCommand::List { state, path, repo } => {
            let diffle = connect(repo, dir).await?;
            print(&comments::list(&diffle, state.as_deref(), path.as_deref()).await?)
        }
    }
}

/// Runs `command`; `dir` is a `-C` given before `tour`, which one after it overrides.
pub async fn tour(command: TourCommand, dir: Option<PathBuf>) -> anyhow::Result<()> {
    match command {
        TourCommand::Push { file, repo } => {
            let html = read_document(file)?;
            let diffle = connect(repo, dir).await?;
            print(&tour::push(&diffle, html).await?)
        }
        TourCommand::Clear { repo } => tour::clear(&connect(repo, dir).await?).await,
    }
}

/// The document at `file`, or on stdin for none or `-`.
fn read_document(file: Option<PathBuf>) -> anyhow::Result<String> {
    let mut html = String::new();
    match file.filter(|f| f.as_os_str() != "-") {
        Some(file) => {
            html = std::fs::read_to_string(&file)
                .map_err(|e| Error::Invalid(format!("cannot read {}: {e}", file.display())))?;
        }
        None => {
            std::io::stdin()
                .read_to_string(&mut html)
                .map_err(|e| Error::Invalid(format!("cannot read stdin: {e}")))?;
        }
    }
    Ok(html)
}

/// The diffle serving the repository `opts` (or `dir`, or the working directory) is in.
async fn connect(opts: RepoOpts, dir: Option<PathBuf>) -> anyhow::Result<Diffle> {
    let dir = match opts.dir.or(dir) {
        Some(dir) => dir,
        None => std::env::current_dir()?,
    };
    let repo = GitRepo::open(&dir).await?;
    Ok(reach(&repo.git_dir).await?)
}

fn print(value: &impl Serialize) -> anyhow::Result<()> {
    let mut out = std::io::stdout().lock();
    writeln!(out, "{}", serde_json::to_string(value)?)?;
    Ok(())
}
