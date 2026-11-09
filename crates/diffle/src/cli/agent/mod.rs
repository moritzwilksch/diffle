//! `diffle comments`: an agent's client of the diffle serving its repository. Every subcommand
//! prints one JSON document on stdout.
mod comments;
mod discover;

use std::io::Write;
use std::path::PathBuf;

use serde::Serialize;

use super::args::{CommentsCommand, ServerOpts};
use crate::git::GitRepo;
use discover::{Diffle, discover};

/// Runs `command`; `dir` is a `-C` given before `comments`, which one after it overrides.
pub async fn run(command: CommentsCommand, dir: Option<PathBuf>) -> anyhow::Result<()> {
    match command {
        CommentsCommand::List { state, path, server } => {
            let diffle = reach(server, dir).await?;
            print(&comments::list(&diffle, state.as_deref(), path.as_deref()).await?)
        }
    }
}

/// The diffle serving the repository `opts` (or `dir`, or the working directory) is in.
async fn reach(opts: ServerOpts, dir: Option<PathBuf>) -> anyhow::Result<Diffle> {
    let dir = match opts.dir.or(dir) {
        Some(dir) => dir,
        None => std::env::current_dir()?,
    };
    let repo = GitRepo::open(&dir).await?;
    Ok(discover(&repo.git_dir, opts.server.as_deref()).await?)
}

fn print(value: &impl Serialize) -> anyhow::Result<()> {
    let mut out = std::io::stdout().lock();
    writeln!(out, "{}", serde_json::to_string(value)?)?;
    Ok(())
}
