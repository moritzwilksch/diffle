//! `diffle completion`: a standalone script derived from the command tree.
use clap::builder::PossibleValuesParser;
use clap::{Command, CommandFactory};
use clap_complete::Shell;

use super::args::Cli;
use super::command;
use crate::protocol::language_ids;

/// The script for `shell`. It completes in the shell alone, so tab completion never starts
/// diffle; static choices stand in for what the parsers accept: the shorthands for revisions,
/// the known languages for language arguments.
pub fn script(shell: Shell) -> String {
    let languages: Vec<String> = language_ids().iter().map(ToString::to_string).collect();
    let choices = |values: Vec<String>| PossibleValuesParser::new(values);
    let cmd: Command = command()
        .mut_arg("revs", |a| a.value_parser(choices(vec!["working".into(), "pr".into(), "range-diff".into()])))
        .mut_subcommand("config", |config| {
            config
                .mut_subcommand("set-lsp", |c| c.mut_arg("language", |a| a.value_parser(choices(languages.clone()))))
                .mut_subcommand("unset-lsp", |c| c.mut_arg("languages", |a| a.value_parser(choices(languages.clone()))))
        });
    let mut cmd = cmd;
    let mut out = Vec::new();
    clap_complete::generate(shell, &mut cmd, Cli::command().get_name().to_owned(), &mut out);
    let mut script = String::from_utf8_lossy(&out).into_owned();
    if shell == Shell::Fish {
        // clap's fish script leaves out the choices of a nested subcommand's arguments.
        let languages = languages.join(" ");
        script += &format!(
            "complete -c diffle -n \"__fish_diffle_using_subcommand config; and __fish_seen_subcommand_from set-lsp unset-lsp\" -f -a \"{languages}\"\n"
        );
    }
    script
}
