//! The `diffle` command line: parses arguments, then serves a review or edits the config.
mod args;
mod completion;
mod config;
mod lifetime;
mod open;
mod paint;
mod parse;
mod serve;
mod timing;

use std::process::ExitCode;

use clap::{Command as ClapCommand, CommandFactory, FromArgMatches};

use crate::error::{Error, GitError};
use crate::protocol::{ModeRequest, language_ids};
use args::{Cli, Command};

/// The command tree, with help that only exists at runtime: the languages diffle knows.
fn command() -> ClapCommand {
    let languages: Vec<String> = language_ids().iter().map(ToString::to_string).collect();
    let known = languages.join(", ");
    Cli::command().mut_subcommand("config", |config| {
        config
            .mut_subcommand("set-lsp", |c| c.mut_arg("language", |a| a.help(format!("one of: {known}"))))
            .mut_subcommand("unset-lsp", |c| c.mut_arg("languages", |a| a.help(format!("one or more of: {known}"))))
    })
}

/// Runs the command line. Usage errors and user errors exit 2, anything else 1.
pub fn main() -> ExitCode {
    let matches = match command().try_get_matches() {
        Ok(matches) => matches,
        Err(e) => {
            let _ = e.print();
            return if e.use_stderr() { ExitCode::from(2) } else { ExitCode::SUCCESS };
        }
    };
    let cli = Cli::from_arg_matches(&matches).unwrap_or_else(|e| e.exit());
    if cli.version {
        println!("{}", env!("DIFFLE_VERSION"));
        return ExitCode::SUCCESS;
    }
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime");
    match runtime.block_on(dispatch(cli)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{} {e:#}", paint::red("✖"));
            ExitCode::from(if is_user_error(&e) { 2 } else { 1 })
        }
    }
}

async fn dispatch(cli: Cli) -> anyhow::Result<()> {
    let (req, later) = match cli.command {
        Some(Command::Config { command }) => return config::run(command).await,
        Some(Command::Completion { shell }) => {
            print!("{}", completion::script(args::shell(&shell)));
            return Ok(());
        }
        Some(Command::Working { opts }) => (ModeRequest::Working, opts),
        Some(Command::Show { rev, opts }) => (ModeRequest::Revspec { args: vec![format!("{rev}^!")] }, opts),
        Some(Command::Pr { pr, opts }) => (ModeRequest::Pr { pr }, opts),
        Some(Command::RangeDiff { ranges, opts }) => (ModeRequest::RangeDiff { args: ranges }, opts),
        // No revisions: review the working tree, like a bare `git diff`.
        None if cli.revs.is_empty() => (ModeRequest::Working, Default::default()),
        None => (ModeRequest::Revspec { args: cli.revs }, Default::default()),
    };
    serve::run(req, cli.global.merge(later)).await
}

/// Whether the reviewer's input caused `e`: a revision, a Git or a GitHub error.
fn is_user_error(e: &anyhow::Error) -> bool {
    e.downcast_ref::<Error>().is_some_and(Error::is_user_error) || e.downcast_ref::<GitError>().is_some()
}
