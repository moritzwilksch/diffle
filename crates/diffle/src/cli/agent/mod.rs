//! `diffle comments`: an agent's client of the diffle serving its repository. Every subcommand
//! prints one JSON document on stdout.
mod comments;
mod server;

use std::io::{Read, Write};
use std::path::PathBuf;

use serde::Serialize;

use super::args::{CommentsCommand, RepoOpts};
use crate::error::Error;
use crate::git::GitRepo;
use server::{Diffle, reach};

/// Runs `command`; `dir` is a `-C` given before `comments`, which one after it overrides.
pub async fn run(command: CommentsCommand, dir: Option<PathBuf>) -> anyhow::Result<()> {
    match command {
        CommentsCommand::List { state, path, repo } => {
            let diffle = connect(repo, dir).await?;
            print(&comments::list(&diffle, state.as_deref(), path.as_deref()).await?)
        }
        CommentsCommand::Reply { thread, body, repo } => {
            let body = if body == "-" { read_stdin()? } else { body };
            let diffle = connect(repo, dir).await?;
            print(&comments::reply(&diffle, &thread, body).await?)
        }
    }
}

/// What stdin holds, to its end.
fn read_stdin() -> anyhow::Result<String> {
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text).map_err(|e| Error::Invalid(format!("cannot read stdin: {e}")))?;
    Ok(text)
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
