# diffle

[![CI](https://img.shields.io/github/actions/workflow/status/moritzwilksch/diffle/ci.yml?style=flat-square&branch=main)](https://github.com/moritzwilksch/diffle/actions/workflows/ci.yml)
[![conda-forge](https://img.shields.io/conda/vn/conda-forge/diffle?logoColor=white&logo=conda-forge&style=flat-square)](https://prefix.dev/channels/conda-forge/packages/diffle)
[![conda-forge-platforms](https://img.shields.io/conda/pn/conda-forge/diffle?style=flat-square)](https://prefix.dev/channels/conda-forge/packages/diffle)
[![npm](https://img.shields.io/npm/v/%40moritzwilksch%2Fdiffle?logo=npm&logoColor=white&style=flat-square)](https://www.npmjs.com/package/@moritzwilksch/diffle)

Review a git diff in the browser, comment on lines or blocks, then copy the
comments as a prompt for an agent.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/diffle-dark.png">
  <source media="(prefers-color-scheme: light)" srcset=".github/assets/diffle-light.png">
  <img alt="diffle reviewing a git diff" src=".github/assets/diffle-light.png">
</picture>

## Usage

```bash
diffle working          # HEAD vs worktree: staged, unstaged, untracked
diffle pr               # merge-base(default branch, HEAD) vs HEAD
diffle branch develop   # merge-base(develop, HEAD) vs HEAD
diffle main...feat      # any git-diff revspec: <rev> | a..b | a...b | a b
diffle export           # print open comments as a prompt
diffle working --lsp    # add Python symbol navigation through pyrefly
diffle --skill          # print the agent-facing usage guide
diffle --help           # list all commands and flags
```

Comments persist in `<git-dir>/diffle/comments.json` and never touch the worktree. They follow changed text where possible and become stale when their text leaves the diff.

Generated files and files matching auto-viewed globs start collapsed. There are no globs by default; configure them in settings or with `diffle config`.

## Shortcuts

- `j` / `k`: next or previous line
- `J` / `K`: next or previous file
- `]` / `[`: next or previous hunk
- `c`: comment
- `R`: resolve
- `V`: select a block
- `v`: mark viewed
- `/`: search the current file
- `g/`: search the diff or codebase
- `gf`: filter files
- `yy`: copy all comments
- `F`: open the full file
- `Ctrl+o`: go back

Press `?` in the app for the full list.

## GitHub reviews

Use the pull request icon to post one thread or all open threads as a GitHub review. This requires a local, authenticated [`gh`](https://cli.github.com/).

Posting works for pushed branches in `pr`, `branch`, or a revspec ending at HEAD. GitHub cannot anchor comments from `working` because those lines are not committed. Stale threads are skipped.

## Language server

Run `diffle working --lsp` to add Python definitions, references, hover details, and symbol search through `pyrefly lsp`.

- `gd` or Command/Ctrl+click: definition
- `gy`: type definition
- `gA`: references
- `gs` / `gS`: file or repository symbols

Set another command with `--lsp <command>` or `diffle config set-lsp <command>`.

For large repositories, raise pyrefly's indexing limit:

```bash
diffle config set-lsp "pyrefly lsp --indexing-mode lazy-blocking --workspace-indexing-limit 20000"
```

For an `src/` layout, add this to `pyproject.toml`:

```toml
[tool.pyrefly]
search-path = ["src"]
```

## Security

> [!WARNING]
> `--host 0.0.0.0` exposes repository paths, refs, patches, file contents, and comments to anyone who can reach the port. Use it only on a trusted network.

The configured language-server command runs through a shell inside the repository and can read anything available to your user.

## Development

```bash
npm install
npm run dev -- working
npm test && npm run typecheck && npm run build
```

See [AGENTS.md](AGENTS.md) for repository notes.

## Acknowledgements

This workflow and tool were inspired by [difit](https://github.com/yoshiko-pg/difit).
