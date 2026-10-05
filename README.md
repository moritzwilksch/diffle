# diffle

[![CI](https://img.shields.io/github/actions/workflow/status/moritzwilksch/diffle/ci.yml?style=flat-square&branch=main)](https://github.com/moritzwilksch/diffle/actions/workflows/ci.yml)
[![conda-forge](https://img.shields.io/conda/vn/conda-forge/diffle?logoColor=white&logo=conda-forge&style=flat-square)](https://prefix.dev/channels/conda-forge/packages/diffle)
[![conda-forge-platforms](https://img.shields.io/conda/pn/conda-forge/diffle?style=flat-square)](https://prefix.dev/channels/conda-forge/packages/diffle)
[![npm](https://img.shields.io/npm/v/%40moritzwilksch%2Fdiffle?logo=npm&logoColor=white&style=flat-square)](https://npmx.dev/package/@moritzwilksch/diffle)
[![website](https://img.shields.io/badge/website-diffle.app-0349b4?style=flat-square)](https://diffle.app)

Review a Git diff in the browser and comment on lines, blocks, or whole files. Then hand the
comments to an agent as a prompt, or to GitHub as a pending review.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/diffle-dark.png">
  <source media="(prefers-color-scheme: light)" srcset=".github/assets/diffle-light.png">
  <img alt="diffle reviewing a git diff" src=".github/assets/diffle-light.png">
</picture>

## Install

```bash
pixi global install diffle               # conda-forge
npm install -g @moritzwilksch/diffle     # npm
```

Or grab the standalone binary, which needs no Node.js. On Linux (x64, arm64, glibc) and Apple
silicon macOS:

```bash
curl -fsSL https://diffle.app/install.sh | sh
```

It installs to `~/.local/bin`. Set `DIFFLE_INSTALL_DIR` to change that, or `DIFFLE_VERSION=v0.1.9`
to pin a release. On Windows (x64, arm64), from PowerShell:

```powershell
irm https://diffle.app/install.ps1 | iex
```

To try it without installing:

```bash
pixi exec diffle working
npx @moritzwilksch/diffle working
nix run github:moritzwilksch/diffle -- working
```

The Nix package bundles `gh`; `#minimal` drops it, and `#web`, `#rust`, and `#python` bundle
language servers.

## Review

```bash
diffle                  # your uncommitted changes
diffle main             # what this branch added since it left main
diffle pr 27            # GitHub PR 27, or its URL
diffle show a1b2c3d     # one commit
diffle main..feat       # any git-diff revspec
```

diffle opens the review in your browser. `j` / `k` move, `J` / `K` jump between files, `c`
comments on a line, and `?` lists every shortcut. Comments live in `<git-dir>/diffle/` and never
touch your worktree.

Close the tab, and diffle prints your open comments as a prompt for an agent:

```bash
claude "$(diffle main)"
```

Or send them to the pull request as a pending GitHub review.

## Documentation

- [Getting started](docs/getting-started.md)
- [Choosing a comparison](docs/guides/choosing-a-comparison.md), [commits](docs/guides/commits.md),
  and [iterations](docs/guides/iterations.md)
- [Threads](docs/guides/threads.md), [agent hand-off](docs/guides/agent-handoff.md), and
  [GitHub](docs/guides/github.md)
- [Code navigation](docs/guides/code-navigation.md) with language servers
- [Remote and proxy setups](docs/guides/remote-and-proxy.md)
- Reference: [keyboard shortcuts](docs/reference/keyboard.md), [CLI](docs/reference/cli.md),
  [configuration](docs/reference/configuration.md), [storage](docs/reference/storage.md)

## Development

```bash
npm install
npm run dev -- working
npm test && npm run typecheck && npm run build
```

Restart `npm run dev` after client changes; the server serves `dist/client`.
`npm run fixture -- <dir>` builds the repository the tests review, covering renames, binaries,
CRLF, and more. Screenshot tests run in Docker so they match CI:

```bash
npm run test:e2e:docker                  # the browser suite
npm run test:e2e:docker -- -g search     # matching scenarios
npm run test:e2e:report                  # open the last report
npm run test:e2e:docker:update           # accept new screenshots
```

See [AGENTS.md](AGENTS.md) for more.

## Acknowledgements

diffle is inspired by [difit](https://github.com/yoshiko-pg/difit).
Diffs are rendered with [@pierre/diffs](https://github.com/pierrecomputer/pierre).
