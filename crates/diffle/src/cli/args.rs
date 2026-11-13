//! The command line: options, the shorthand commands, and `config` / `completion` / `comments` / `tour`.
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
  diffle main              same as main...worktree: what this branch adds since it left main,
                           uncommitted changes included
  diffle HEAD~3            the last three commits and the uncommitted changes
  diffle main..feat        main vs feat
  diffle main...feat       what feat added since it left main
  diffle main..worktree    main vs the uncommitted tree (\"worktree\" works on either side)
  diffle a1b2c3d^!         the commit a1b2c3d alone, like git show

Without revisions, diffle compares HEAD..worktree.

Status goes to stderr, so stdout carries only the review: unless --keep-alive is set,
closing the last auto-opened browser tab (with --socket, the last tab connected) stops
diffle and prints the open comments as a prompt for an agent.
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
    /// listen on a Unix socket at <path> that only you can connect to, in place of a port, e.g.
    /// to forward with ssh -L; opens no browser
    #[arg(long, value_name = "path", value_hint = ValueHint::FilePath)]
    pub socket: Option<PathBuf>,
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
    /// do not check out the new side of the review
    #[arg(long = "no-checkout")]
    pub no_checkout: bool,
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
    /// read and answer the comments of the review running for this repository, as an agent
    Comments {
        #[command(subcommand)]
        command: CommentsCommand,
    },
    /// show a guided tour of the review diffle is running for this repository, as an agent
    Tour {
        #[command(subcommand)]
        command: TourCommand,
    },
    /// print what diffle offers a coding agent, as a skill to install as is
    Skill {
        /// leave out the frontmatter that names the skill and says when to use it
        #[arg(long)]
        no_frontmatter: bool,
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

#[derive(Subcommand, Debug)]
pub enum CommentsCommand {
    /// print the threads the reviewer is shown, with the key of their set, as JSON
    List {
        /// which threads to print (default: all)
        #[arg(long, value_name = "state", value_parser = ["open", "resolved", "all"])]
        state: Option<String>,
        /// only the threads on this file, relative to the repository root
        #[arg(long, value_name = "path")]
        path: Option<String>,
        #[command(flatten)]
        repo: RepoOpts,
    },
    /// reply to a thread as the agent; prints the thread as JSON
    Reply {
        /// the thread's id, as `diffle comments list` prints it
        #[arg(value_name = "thread-id")]
        thread: String,
        /// the reply, in Markdown (`-`: stdin)
        #[arg(value_name = "body|-")]
        body: String,
        #[command(flatten)]
        repo: RepoOpts,
    },
}

#[derive(Subcommand, Debug)]
pub enum TourCommand {
    /// check an HTML tour and show it in place of the review's tour; prints it as JSON
    Push {
        /// the HTML document (default: stdin)
        #[arg(value_name = "file|-", value_hint = ValueHint::FilePath)]
        file: Option<PathBuf>,
        #[command(flatten)]
        repo: RepoOpts,
    },
    /// remove the review's tour
    Clear {
        #[command(flatten)]
        repo: RepoOpts,
    },
}

/// The repository whose running diffle a `diffle comments` or `diffle tour` call talks to.
#[derive(Args, Debug, Clone, Default)]
pub struct RepoOpts {
    /// run as if started in <path> (any directory inside a git worktree)
    #[arg(short = 'C', value_name = "path", value_hint = ValueHint::DirPath)]
    pub dir: Option<PathBuf>,
}

impl GlobalOpts {
    /// These options with `later`'s, given after a shorthand, taking precedence.
    pub fn merge(self, later: Self) -> Self {
        Self {
            dir: later.dir.or(self.dir),
            port: later.port.or(self.port),
            host: later.host.or(self.host),
            allowed_origin: later.allowed_origin.or(self.allowed_origin),
            socket: later.socket.or(self.socket),
            no_open: self.no_open || later.no_open,
            keep_alive: self.keep_alive || later.keep_alive,
            no_watch: self.no_watch || later.no_watch,
            auto_viewed: [self.auto_viewed, later.auto_viewed].concat(),
            context: later.context.or(self.context),
            lsp: [self.lsp, later.lsp].concat(),
            no_lsp: self.no_lsp || later.no_lsp,
            no_checkout: self.no_checkout || later.no_checkout,
            timing: self.timing || later.timing,
        }
    }

    pub fn host(&self) -> &str {
        self.host.as_deref().unwrap_or("127.0.0.1")
    }
}
