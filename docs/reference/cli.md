---
title: CLI
description: diffle's commands, flags, and revision syntax.
sidebar:
  order: 2
---

```text
diffle [options] [revs...]
diffle config <command>
diffle lsp
diffle completion --shell <bash|zsh|fish>
```

`diffle --help` prints the same information for the version you have installed.

## Revisions

| Revisions             | Compares                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| _(none)_              | `HEAD` against the worktree                                                                         |
| `working`             | The same: staged, unstaged, and untracked changes                                                   |
| `<rev>`               | `<rev>...HEAD`: what `HEAD` added since it left `<rev>`                                             |
| `<a>..<b>`, `<a> <b>` | `<a>` against `<b>`                                                                                 |
| `<a>...<b>`           | What `<b>` added since it left `<a>` (from the merge base)                                          |
| `<rev>^!`             | One commit against its first parent                                                                 |
| `show [rev]`          | The same as `<rev>^!`; `HEAD` by default                                                            |
| `pr [number\|url]`    | A GitHub pull request's `base...head`, fetched if needed; without an argument, the current branch's |

`worktree` names the uncommitted tree on either side, as in `main..worktree`. Everything else follows
`git diff`. See [Choosing a comparison](../guides/choosing-a-comparison.md).

## Options

| Option                      | Effect                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| `-C <path>`                 | Run as if started in `<path>`, any directory inside a Git worktree                                        |
| `-p`, `--port <port>`       | Port to listen on. Default 4966, or the next free one; `0` picks a random port                            |
| `-H`, `--host <host>`       | Address to bind. Default `127.0.0.1`; `0.0.0.0` exposes diffle on the network                             |
| `--allowed-origin <origin>` | Trust this public HTTP(S) origin, without a path, [behind a reverse proxy](../guides/remote-and-proxy.md) |
| `--no-open`                 | Don't open a browser                                                                                      |
| `--keep-alive`              | Keep running after the last browser tab closes                                                            |
| `--no-watch`                | Don't watch the worktree and refs for changes                                                             |
| `--auto-viewed <glob>`      | Start matching files viewed, for this run. Repeatable                                                     |
| `-U`, `--context <n>`       | Unchanged lines around each change, for this run. Default: the config, 5                                  |
| `--lsp <language=command>`  | Language server for one language, for this run. Repeatable                                                |
| `--no-lsp`                  | Start no language server                                                                                  |
| `--timing`                  | Print startup phase timings to stderr                                                                     |
| `-v`, `--version`           | Print the version                                                                                         |
| `-h`, `--help`              | Print help                                                                                                |

## Output and exit

Status goes to stderr. Unless `--keep-alive` is set, closing the last browser tab that diffle opened
stops it and prints the open comments to stdout as a [prompt](../guides/agent-handoff.md). `Ctrl+C`
always stops it, and prints the prompt too.

diffle exits with status 2 on invalid input, such as an unknown revision or a malformed flag.

## `diffle config`

Shows or edits the [user config](./configuration.md), the same settings as the Settings dialog.

| Command                           | Effect                                                      |
| --------------------------------- | ----------------------------------------------------------- |
| `show`                            | Print the config file's path and contents                   |
| `add-auto-viewed <glob...>`       | Add patterns for files that start viewed                    |
| `remove-auto-viewed <glob...>`    | Remove such patterns                                        |
| `set-context <n>`                 | Set the context lines around changes                        |
| `set-follow-refs <on\|auto\|off>` | Set when a moved ref reloads the review                     |
| `set-lsp <language> <command>`    | Set the language server for one language; `""` turns it off |
| `unset-lsp <language...>`         | Forget an override and go back to `PATH`                    |

## `diffle lsp`

Prints the language server each language would get, and what is missing from `PATH`. See
[Code navigation](../guides/code-navigation.md#which-server-runs).

## `diffle completion`

Prints a completion script. Install it for the current user, then start a new shell:

```bash
diffle completion --shell bash > ~/.local/share/bash-completion/completions/diffle
diffle completion --shell zsh > ~/.local/share/zsh/site-functions/_diffle   # on fpath, before compinit
diffle completion --shell fish > ~/.config/fish/completions/diffle.fish
```

The script is static: run it again after upgrading to pick up new options. Revisions don't complete.
