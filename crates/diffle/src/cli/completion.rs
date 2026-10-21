//! `diffle completion`: clap's script for one shell, on stdout.
use clap::CommandFactory;
use clap_complete::Shell;

use super::args::Cli;

pub fn print(shell: Shell) {
    clap_complete::generate(shell, &mut Cli::command(), "diffle", &mut std::io::stdout());
}
