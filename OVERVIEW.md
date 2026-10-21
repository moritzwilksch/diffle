# diffle: architecture and data flow

diffle is a local Git review tool. One Rust binary opens a repository, computes a diff, serves a
browser client over HTTP, and keeps that client in step with the repository until the review ends.
Comments written in the browser are persisted next to the repository and leave the tool as an
agent prompt on stdout or as a pending GitHub review.

```
                 ┌──────────────────────────── diffle binary (Rust, tokio + axum) ───────────────────────────┐
  CLI args ───►  │ cli ─► Session ──► Snapshotter ──► git (exec, cat-file)                                     │
                 │          │  queue      │ cache                                                              │
                 │          │             └──► Snapshot{tree, changed, patches, commits, iterations}          │
                 │          ├─► CommentStore  ──► <git-dir>/diffle/comments.json                              │
                 │          ├─► Watcher (notify + polling) ──► refresh ──► Hub(/ws) ──► "snapshot v+1"        │
                 │          └─► LspPool ──► language servers on PATH                                          │
                 │ server: /api/* routes + /ws hub + embedded client (rust-embed), behind a Host/Origin guard │
                 └──────────────────────────────────────────────────────────────────────────────────────────┘
                                   ▲ HTTP JSON / text            │ WebSocket (server → client only)
                                   │                             ▼
                 ┌──────────────────────────── browser client (React, Zustand, @pierre/diffs) ────────────────┐
                 │ api.ts (URLs) ─► store.ts (state + effects, generation-guarded) ─► ReviewPane / tree /     │
                 │ comments / header / lsp views; model.ts holds the pure state functions                    │
                 └──────────────────────────────────────────────────────────────────────────────────────────┘
```

## Components

### Contract: `src/shared/protocol.ts`

Every shape that crosses the client/server boundary is a zod schema here: mode requests, the
`Snapshot`, changed files, comment threads and anchors, LSP responses, the WebSocket
`ServerMessage`. A vitest script exports it to `crates/diffle/protocol.generated.json`, and
`build.rs` turns that into Rust types with typify (`crate::protocol`). The Rust side never defines a
wire shape of its own, so the two sides cannot drift apart silently.

### CLI: `crates/diffle/src/cli/`

Clap parses a review request (`working`, `pr`, a revspec, a `range-diff`) and global options such
as the port, `--lsp` overrides, and `--no-open`. `serve.rs` is the run: open the repository, resolve
the request, build the `Session`, the `Hub`, and optionally the `LspPool`, bind the HTTP server,
open the browser, and wait for the end. The run ends on a signal, or once a browser connected and
the last tab has stayed closed for a grace period (`lifetime.rs`). At shutdown the open comment
threads are formatted as a prompt and written to stdout, the only thing stdout ever carries; status
lines go to stderr.

### Git: `crates/diffle/src/git/`

The one place that runs git. `exec.rs` spawns it with explicit argv and NUL-delimited output;
`catfile.rs` keeps a long-lived `cat-file --batch` for object reads. The other modules are parsers
over those outputs: `changes.rs` (name-status between endpoints, worktree and untracked files),
`patch.rs` (unified diffs with the configured context), `refs.rs`, `commits.rs`, `files.rs`
(tree listings and reads), `grep.rs` (search). `GitRepo::fetch` only writes `refs/diffle/`, which
is how pull requests are brought in without touching the user's refs.

### Reviews: `crates/diffle/src/mode/`

Turns a request into a `Review`, the specification of what is under review and nothing resolved:
a range between two revisions (`old`, `new`, either may be the worktree, with `base` saying
whether the old side is itself or the merge base) carrying the slice on screen, or one commit
against its first parent. The slice, a `RangeView`, is the whole range, one of its commits, its
uncommitted changes, or an interdiff: what the range changed since a recorded iteration or a named
range, optionally narrowed to one pair of commits. A range entered as a pull request carries the
pull request's identity. `revspec.rs` parses `A..B`, `A...B`, `A^!` and the range-diff forms;
`resolve.rs` resolves ranges and commits to hashes; `pr.rs` fetches a pull request into session
refs; `view.rs` resolves the slice a review shows, with `rangediff.rs` replaying and pairing
commits; `keys.rs` derives where the review's comments live from what was entered.

### Session: `crates/diffle/src/session/`

The owner of the active mode and everything derived from it. All mutations run through one queue
on a dedicated task, in request order: entering a review and showing a slice (`transitions.rs`), refreshes and reloads
(`refresh.rs`), context changes. `Snapshot.version` is allocated only inside that queue, so the
versions clients see are monotonic. `files.rs` answers file reads through the snapshot's
allowlist: the new side is the snapshot's tree, the old side additionally maps a rename's new path
to its old one. `github.rs` discovers the pull request behind a comparison and runs the export.
`watch.rs` starts the watcher for the mode and turns its signal into a refresh (worktree and
followed ranges) or a `moved` notice (a comparison between refs that is not followed).

### Snapshotter: `crates/diffle/src/snapshotter.rs`

Computes one mode's `Snapshot` and caches it with its patches until the session invalidates it.
A snapshot holds the resolved endpoints, the checked-out HEAD, the changed files with their
metadata (status, binary, generated flag from `generated.rs`, image keys), the full new-side tree,
the range's commits, and the recorded iterations (`iterations.rs` keeps a followed range's
successive endpoint pairs in `<git-dir>/diffle/iterations.json`). Patches are computed lazily per
path and shared between callers; the first few are prewarmed when a snapshot lands.

### Comments: `crates/diffle/src/comments/`

Threads and viewed marks live in `<git-dir>/diffle/comments.json`, one set per `commentKey`, so
reviewing the same comparison again finds its comments. A thread anchors to a file or a line range
on one side with the quoted text; `relocation.rs` moves anchors when a refresh changes the diff and
marks the ones it cannot place as stale. `import.rs` places anchors arriving from outside (a
GitHub review) against the current snapshot, and `format.rs` renders threads as the prompt.

### GitHub: `crates/diffle/src/github/`

`client.rs` resolves a token (environment, then `gh auth token`) and owns the one HTTP client.
`metadata.rs` finds the pull request a comparison corresponds to, `pulls.rs` names pull requests
for the `pr` mode, and `review.rs` with `pending_review.rs` turns open threads into a pending
GitHub review through GraphQL.

### Language servers: `crates/diffle/src/lsp/`

`LspPool` starts one process per server the snapshot's languages need, as defined in
`projects/catalog.rs` and resolved by `registry.rs` against PATH and the user's overrides. Each
`process/` owns a server's stdio, status, log, and progress; `documents.rs` keeps the server's open
documents equal to the snapshot's new side; `locator.rs` maps result URIs back to snapshot paths;
`bridge.rs` sends the LSP requests; `merge.rs` combines answers when several servers cover a
language. Queries are only answered while the new side is the checkout the servers read, decided in
one shared function (`lsp_blocker`, ported from `src/shared/lsp.ts` so the client refuses the same
cases without a round trip).

### Server: `crates/diffle/src/server/`

axum routes under `/api/` (`routes/api.rs` for snapshot, mode, refs, config and iterations;
`files.rs` for patches, file contents, images and search; `comments.rs` for threads and viewed
marks; `lsp.rs` for symbol queries), the `/ws` broadcast hub, and the client assets embedded by
rust-embed (a debug build reads `dist/client` from disk). `guard.rs` admits only loopback hosts
and an explicitly allowed public origin, so a page on another site cannot reach the API.

### Client: `src/client/`

`api.ts` is the only module that knows URLs. `store.ts` holds the Zustand state and every effect:
boot, mode switches, patch and file loading, cursor and navigation, comments, search, LSP
queries. `model.ts` keeps the pure state functions and item identity apart from the store.
`review/ReviewPane.tsx` renders the diffs with `@pierre/diffs`, measures them, and places jumps
at a fixed gaze point; `tree/` is the file tree, `comments/` the side panel with the thread list,
the commit navigator and the iteration list, `header/` the mode picker and status, `lsp/` the
hover, occurrence, references and symbol views plus syntax classification in a worker, `keyboard/`
the keymap.

## Data flow

### Boot

1. The CLI opens the repository and resolves the request into a `Review`, failing before anything
   is served when the input is invalid.
2. `Session::activate` creates the mode's `Snapshotter`, `CommentStore`, and watcher, computes the
   first snapshot, and starts the language servers the snapshot's languages need.
3. The HTTP server binds, the browser opens, and the client's `boot()` fetches `/api/snapshot`,
   threads, viewed marks, config, LSP status, and the `moved` state in parallel.
4. The client renders the tree and the changed files, loading patches in bounded batches through
   `POST /api/patch`; full file views and image sides come from `/api/file` and `/api/image`, which
   serve only paths in the snapshot's allowlist.

### Staying current

The server never pushes data over the WebSocket, only hints: `snapshot {version}`, `moved`,
`threads`, `viewed`, `config`, and the LSP status. The client refetches what the hint names through
the API, so a reconnect simply reruns `boot()` and nothing is replayed.

A change reaches the client as follows:

1. The watcher sees it. The worktree is watched natively (per directory on Linux, skipping what git
   ignores) and git's own metadata (HEAD, refs, the index) is polled at full timestamp resolution,
   because git replaces those files atomically and native watches lose that.
2. After a debounce, `on_dirty` runs on the session queue. A followed mode refreshes: the
   snapshotter is invalidated, a new snapshot is computed with the next version, comments are
   relocated against it, and `snapshot` is broadcast. A comparison between refs that is not followed
   only broadcasts `moved`, and the reviewer chooses when to reload.
3. The client receives the version, fetches the new snapshot, keeps the diffs whose change is the
   same as before (same blobs on both sides), and reloads the rest, leaving the stale diff on screen
   until its replacement lands so nothing reflows under the reader. Every async commit in the store
   checks that its generation is still current, so a result from a superseded boot, refresh, or
   mode switch is dropped.

### Entering and showing

Entering another review (`POST /api/review`) and showing a slice of the active range
(`PUT /api/view`) go through the same queue: the old watcher and stores are dropped, the review is
resolved and activated, and the response carries the first snapshot. The client treats it as a new
generation. A slice keeps the range's commits listed and its iterations recorded, so the reviewer
moves between a commit, the uncommitted changes, an interdiff and the whole range without leaving
the range; the snapshot's `follows` and `commentKey` say what each slice follows and where its
comments live, and comments are off in an interdiff.

### Comments out

Every thread mutation goes through `/api/threads` and lands in `comments.json` under the mode's
key, with a `threads` hint to other tabs. At the end of the run, or on `GET /api/threads/export`,
the open threads become a prompt with each quoted range, so an agent can act on the review. With a
pull request behind the comparison and a token available, `POST /api/github/export` creates a
pending review on GitHub with the same threads as review comments, and GitHub's existing review
comments can be imported and placed against the current snapshot.

### Symbol navigation

A hover, definition, reference, occurrence, or symbol query posts a snapshot position to
`/api/lsp/*`. The route refuses it with a 409 and the reason when the servers are off, the new side
is not the checkout, no server covers the language, or the path is not in the snapshot. Otherwise
the pool makes sure the document is open at the snapshot's content, forwards the request to every
server covering the language, merges their answers, and maps result locations back to snapshot
paths. A location outside the snapshot is served by `/api/file` only after a server named it.

## Where state lives

| State                                        | Location                                                    | Owner                  |
| -------------------------------------------- | ----------------------------------------------------------- | ---------------------- |
| Active mode, snapshot, version               | memory, `Session` + `Snapshotter`                           | session queue          |
| Comments, viewed marks                       | `<git-dir>/diffle/comments.json`, keyed by `commentKey`     | `CommentStore`         |
| Recorded iterations of a followed range      | `<git-dir>/diffle/iterations.json`                          | `IterationStore`       |
| Fetched pull request heads                   | `refs/diffle/*`                                             | `GitRepo::fetch`       |
| User configuration                           | `$XDG_CONFIG_HOME/diffle/config.json` (default `~/.config`) | `UserConfigStore`      |
| JSON schema catalog cache for the LSPs       | `~/.cache/diffle/schemastore.json`                          | `lsp/configuration.rs` |
| Client UI state (cursor, layout, selections) | browser memory, some in `localStorage`                      | `store.ts`             |

The worktree is never written to.
