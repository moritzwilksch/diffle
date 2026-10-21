//! The command line: options, the shorthand commands, and `config` / `completion`.
use std::path::PathBuf;

use clap::{ArgAction, Args, Parser, Subcommand, ValueHint};
use clap_complete::Shell;

use super::parse::{self, LspOverride};

const AFTER_HELP: &str = "\
Shorthands (in place of <revs>):
  working                  same as HEAD..worktree: uncommitted changes, staged and untracked
                           included
  pr [number|url]          a GitHub pull request: its base...head, fetched if needed
                           (without an argument: the pull request for this branch)
  show [rev]               same as <rev>^!: one commit against its first parent, pinned
                           (default: HEAD)
  range-diff <ranges...>   how one series of commits became another, like git range-diff:
                           <a>..<b> <c>..<d> | <base> <b> <d> | <b>...<d>

Revisions follow git diff, except that a lone one compares from the merge base:
  diffle main              same as main...HEAD: what this branch added since it left main
  diffle HEAD~3            the last three commits
  diffle main..feat        main vs feat
  diffle main...feat       what feat added since it left main
  diffle main..worktree    main vs the uncommitted tree (\"worktree\" works on either side)
  diffle a1b2c3d^!         the commit a1b2c3d alone, like git show

Without revisions, diffle compares HEAD..worktree.

Status goes to stderr, so stdout carries only the review: unless --keep-alive is set,
closing the last auto-opened browser tab stops diffle and prints the open comments
as a prompt for an agent.
Ctrl+C always stops it.

Docs: https://diffle.app
Source and issues: https://github.com/moritzwilksch/diffle";

const COMPLETION_HELP: &str = "\
Install it for the current user, then start a new shell:
  bash  diffle completion --shell bash > ~/.local/share/bash-completion/completions/diffle
  zsh   diffle completion --shell zsh > ~/.local/share/zsh/site-functions/_diffle
        (any directory that .zshrc puts on fpath before compinit)
  fish  diffle completion --shell fish > ~/.config/fish/completions/diffle.fish

Run it again after upgrading diffle: the script is static, so new options do not appear
on their own.";

#[derive(Parser, Debug)]
#[command(
    name = "diffle",
    // Usage lines and completion scripts name the command the same on every platform, not `diffle.exe`.
    bin_name = "diffle",
    about = "Review a git diff in the browser and export line comments as an agent prompt.",
    after_help = AFTER_HELP,
    disable_help_flag = true,
    disable_version_flag = true,
    disable_help_subcommand = true,
    // A repeated option takes its last value: a wrapper may add its own `--port` after the user's.
    args_override_self = true,
    max_term_width = 100
)]
pub struct Cli {
    /// print the version and exit
    #[arg(short = 'v', long)]
    pub version: bool,
    /// display help for command
    #[arg(short = 'h', long, global = true, action = ArgAction::Help)]
    pub help: Option<bool>,
    #[command(flatten)]
    pub global: GlobalOpts,
    /// git-diff style revisions: <rev> | <a>..<b> | <a>...<b> | <a> <b>
    #[arg(value_name = "revs")]
    pub revs: Vec<String>,
    #[command(subcommand)]
    pub command: Option<Command>,
}

/// What a review run takes; given before the shorthand, after it, or both, merged with the later winning.
#[derive(Args, Debug, Clone, Default)]
pub struct GlobalOpts {
    /// run as if started in <path> (any directory inside a git worktree)
    #[arg(short = 'C', value_name = "path", value_hint = ValueHint::DirPath)]
    pub dir: Option<PathBuf>,
    /// port to listen on (default: 4966, or the next free one; 0 = random)
    #[arg(short, long, value_name = "port", value_parser = parse::port)]
    pub port: Option<u16>,
    /// address to bind; use 0.0.0.0 to expose on the network (default: 127.0.0.1)
    #[arg(short = 'H', long, value_name = "host")]
    pub host: Option<String>,
    /// trusted public HTTP(S) origin behind a reverse proxy (without a path)
    #[arg(long, value_name = "origin", value_parser = parse::allowed_origin)]
    pub allowed_origin: Option<String>,
    /// do not open a browser
    #[arg(long = "no-open")]
    pub no_open: bool,
    /// keep the server running after all browser tabs close
    #[arg(long)]
    pub keep_alive: bool,
    /// do not watch for changes
    #[arg(long = "no-watch")]
    pub no_watch: bool,
    /// mark matching files viewed for this session (repeatable)
    #[arg(long, value_name = "glob")]
    pub auto_viewed: Vec<String>,
    /// context lines around changes for this session (default: config, 5)
    #[arg(short = 'U', long, value_name = "n", value_parser = parse::context)]
    pub context: Option<u32>,
    /// language server command for one language, started for this run (repeatable); by default the
    /// diff's languages are served by whatever is on PATH
    #[arg(long, value_name = "language=command", value_parser = parse::lsp_override)]
    pub lsp: Vec<LspOverride>,
    /// do not start any language server
    #[arg(long = "no-lsp")]
    pub no_lsp: bool,
    /// print startup phase timings to stderr
    #[arg(long)]
    pub timing: bool,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    #[command(
        hide = true,
        args_override_self = true,
        about = "Same as `diffle HEAD..worktree`: uncommitted changes, staged and untracked files included."
    )]
    Working {
        #[command(flatten)]
        opts: GlobalOpts,
    },
    #[command(
        hide = true,
        args_override_self = true,
        about = "Same as `diffle <rev>^!`: one commit against its first parent, as git show shows it."
    )]
    Show {
        /// the commit to review
        #[arg(value_name = "rev", default_value = "HEAD")]
        rev: String,
        #[command(flatten)]
        opts: GlobalOpts,
    },
    #[command(
        hide = true,
        args_override_self = true,
        about = "A GitHub pull request, as GitHub shows it: merge-base(base, head) vs head."
    )]
    Pr {
        /// pull request number or url; default: the pull request for this branch
        #[arg(value_name = "pr")]
        pr: Option<String>,
        #[command(flatten)]
        opts: GlobalOpts,
    },
    #[command(
        hide = true,
        args_override_self = true,
        about = "How one series of commits became another, as git range-diff shows it: the older range replayed \
                 onto the newer one’s base against the newer range, with the commits paired."
    )]
    RangeDiff {
        /// two ranges: <a>..<b> <c>..<d>, <base> <b> <d>, or <b>...<d>
        #[arg(required = true, value_name = "ranges")]
        ranges: Vec<String>,
        #[command(flatten)]
        opts: GlobalOpts,
    },
    /// print the config file path and contents
    Config,
    /// show the language server each language would get, and what is missing from PATH
    Lsp,
    /// print a shell completion script
    #[command(after_help = COMPLETION_HELP)]
    Completion {
        /// shell to generate the script for
        #[arg(short, long, value_name = "shell", value_enum)]
        shell: Shell,
    },
}

impl GlobalOpts {
    /// These options with `later`'s, given after a shorthand, taking precedence.
    pub fn merge(self, later: Self) -> Self {
        Self {
            dir: later.dir.or(self.dir),
            port: later.port.or(self.port),
            host: later.host.or(self.host),
            allowed_origin: later.allowed_origin.or(self.allowed_origin),
            no_open: self.no_open || later.no_open,
            keep_alive: self.keep_alive || later.keep_alive,
            no_watch: self.no_watch || later.no_watch,
            auto_viewed: [self.auto_viewed, later.auto_viewed].concat(),
            context: later.context.or(self.context),
            lsp: [self.lsp, later.lsp].concat(),
            no_lsp: self.no_lsp || later.no_lsp,
            timing: self.timing || later.timing,
        }
    }

    pub fn host(&self) -> &str {
        self.host.as_deref().unwrap_or("127.0.0.1")
    }
}
