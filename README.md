# diffle

Review a git diff in the browser, comment on lines or blocks, copy the
comments as a prompt for an agent.

```text
src/app.py:42-44

> for x in items:
>     process(x)

Batch this instead of looping.
```

## Usage

```bash
diffle working          # HEAD vs worktree: staged, unstaged, untracked
diffle pr               # merge-base(default branch, HEAD) vs HEAD, like a PR
diffle branch develop   # merge-base(develop, HEAD) vs HEAD
diffle main...feat      # any git-diff revspec: <rev> | a..b | a...b | a b
diffle export           # print the open threads as a prompt, no server needed (--format json, --state all)
diffle --skill          # print the agent-facing usage guide (feed it to your agent)
diffle --version        # print the installed version
diffle working --lsp    # plus go-to-definition, references and symbols via `pyrefly lsp`
diffle --help           # all flags: -C, --port (default 4966, next free if taken), --host, --no-open, --no-watch, -U, --auto-viewed, --lsp, --comment, --as, --background
```

Comments are threads: a line range, then messages from you and from an agent.
Reply, resolve, or delete them inline; resolved threads leave the prompt.
Bodies render as GitHub-flavored markdown (bold, `code`, fenced blocks, lists,
tables; raw HTML stays literal). A
` ```suggestion ` block in a message exports as ORIGINAL / SUGGESTED fences
(the composer's "Suggest change" button prefills one). Threads persist in
`<git-dir>/diffle/comments.json`, keyed by what is being compared, and never
touch the worktree. The view updates live while files change; threads follow
their text and are flagged stale when it disappears or leaves the diff.

Files matching auto-viewed globs (`*.lock` and friends by default) and files
that look generated (lockfiles, minified bundles, `@generated` / `DO NOT EDIT`
headers) start collapsed; edit the globs in the settings dialog or with
`diffle config`. A file you marked viewed that changes afterwards shows a
half-filled mark: changed since you viewed it.

Keys are vim-style: `j`/`k` lines, `J`/`K` files, `]`/`[` hunks, `c` comment,
`R` resolve, `V` block select, `v` viewed, `/` search the current file, `g/`
search the diff or codebase, `gf` filter the file tree, `yy` copy all. `F` (or
the header button, or a file picked from the tree that is not in the diff) opens
the whole file in place of the diff list; Ctrl+o or the back button return to
where you were. Press `?` in the app for the full list.

## Post to GitHub

The pull-request icon on a thread, or in the threads panel head for all open
threads, posts the comments as one review on the current branch's pull request
through the local `gh` (installed and logged in). Lines anchor to the checked-out
commit, so it works in `pr`, `branch`, or a revspec ending at HEAD, after the
branch is pushed; `working` is refused, since GitHub cannot anchor to
uncommitted lines. Stale threads are skipped and counted in the toast. Agent
messages carry their author label; ` ```suggestion ` blocks stay as GitHub
suggestions.

## Agent loop

Status goes to stderr, so stdout carries only payloads. The simplest round trip
is one command: the agent runs it, the human reviews in the browser, and
closing the server (Ctrl+C) prints the open threads as the prompt.

```bash
diffle working --comment @findings.json --as claude   # seed the agent's findings, block until the human is done
```

`findings.json` is one object or an array of `{path, startLine, endLine?, side?, body}`;
the server quotes the lines itself. Duplicates of open threads are skipped.

For longer sessions, detach and talk to the server over its run file
(`<git-dir>/diffle/server.json`; `--url` or `--port` override it, for example
when the human is looking at a server bound to another address):

```bash
diffle working --background            # prints {"port","url","pid"}; stop it with kill <pid>
diffle comment add @findings.json --as claude   # {"added","skipped","threadIds"}
diffle comment get                     # open threads as the prompt; --state open|resolved|all, --format prompt|json
diffle comment reply <threadId> <body> # answer a human message; --as labels it
diffle comment resolve <threadId>...   # {"resolved","notFound"}; exit 1 if any id is unknown
```

`diffle --skill` prints this loop as a short guide written for agents; paste it
into a system prompt or a skill file.

Storage is `version: 2`; an existing v1 file is migrated once and backed up as
`comments.v1.bak`.

`--lsp` starts a language server (default `pyrefly lsp`; change it with
`--lsp <command>` or `diffle config set-lsp <command>`) for Python symbol navigation while reviewing
your checkout (`working`, `pr`, `branch`, or any revspec whose new side is HEAD): resting the pointer on a
symbol (or `gh` on the focused word) shows its signature and documentation in a tooltip (Esc or moving away closes it), `gd` or ⌘/Ctrl+click jumps to the definition of the hovered
symbol, `gy` to the definition of its type, `gA` lists its references (`n`/`N` step, Ctrl+o returns), and `gs`/`gS`
search symbols in the current file or the repository.

The diff's Python files stay open in the server with the reviewed text, so
references in them are found even before the server has indexed the repository
and even when they are past its indexing cap. References in unchanged files
depend on that index: pyrefly builds it in the background from the first open
and stops after 2000 files, so on a large repository run it with
`diffle config set-lsp "pyrefly lsp --indexing-mode lazy-blocking --workspace-indexing-limit 20000"`
to make each query wait for the index and to raise the cap. The header shows a
spinner while pyrefly indexes. An `src/` layout
needs `search-path = ["src"]` under `[tool.pyrefly]` in `pyproject.toml`, or
definitions resolve but references stop at the file's own module.

## Security

diffle is a local tool. The API has no authentication; it relies on the
default `127.0.0.1` bind and rejects requests whose `Host` is not loopback or
whose `Origin` differs from `Host`. `--host 0.0.0.0` exposes the repository
(paths, refs, patches, file contents, comments) to everyone on the network who
can reach the port; use it only on a trusted network. A visitor types the
machine's IP address or hostname into the address bar; a page served from any
other name is refused, so a DNS-rebinding attack still cannot reach the API.

Any local process can read and write threads through the API, and
`diffle comment` relies on that: there is no token. `--background` leaves a
server running until its pid is killed; the run file records it.

The language-server command runs with a shell inside the repository. It can
read ignored files and anything else the user can. Only the CLI can change it
(`diffle config set-lsp`); the settings dialog shows it read-only.

Threads (`<git-dir>/diffle/comments.json`, which quotes source lines), the run
file, the background log and the user config are written owner-only (`0600`).

## Development

```bash
npm install
npm run dev -- working    # note the `--` before flags
npm test && npm run typecheck && npm run build
```

Working in this repo: [AGENTS.md](AGENTS.md).
