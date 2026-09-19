# Working in diffle

Diffle is a local Git review app: a Node/Hono server owns repository state; a React client renders diffs with `@pierre/diffs`; comments can become an agent prompt or a pending GitHub review. Keep `README.md` focused on installation, core workflows, and user-visible constraints. Let `--help`, code, and tests carry exhaustive detail.

## Find the owner

- `src/shared/protocol.ts`: the only client/server contract. Define cross-boundary fields here first.
- `src/server/git/GitRepo.ts`: all Git execution. Use explicit argv and preserve stable, NUL-delimited parser inputs where applicable.
- `src/server/Session.ts`: active mode, snapshots, comments, watcher, and serialized transitions.
- `src/server/Snapshotter.ts`: derives trees, changed files, and patches for one mode.
- `src/server/routes.ts`: HTTP behavior; `src/server/ws.ts`: server-to-client invalidation messages.
- `src/server/comments/`: persistence, relocation, import, and prompt formatting.
- `src/server/github.ts`: `gh` integration and pending-review export.
- `src/server/lsp/LspBridge.ts`: language-server process and JSON-RPC lifecycle.
- `src/client/api.ts`: the only client module that knows URLs.
- `src/client/store.ts`: Zustand state and effects; guard async commits with the current generation.
- `src/client/model.ts`: pure state functions and item identity, kept separate to avoid store cycles.
- `src/client/review/ReviewPane.tsx`: `CodeView` rendering, measurement, and scroll placement.

## Preserve these invariants

- `Session` alone advances `Snapshot.version`; mode switches, refreshes, and context changes stay serialized.
- `Snapshot.tree` is the new-side allowlist. File and LSP reads go through `Session.readSide`; it also maps a rename's old path. The one exception is `LspBridge.readExternal`: `/api/file` serves a file outside the snapshot on the new side only after a language-server result named it.
- Persist review state under `<git-dir>/diffle/`, keyed by `ModeSpec.commentKey`; keep the worktree untouched.
- PR fetches use session-owned `refs/diffle/` refs. `GitRepo.fetch` must reject destinations outside them.
- Treat rendered `FileDiffMetadata` as immutable. Hydrate with `hydratePartialDiff('clone', ...)`, replace the store entry, and change its generation-backed item id.
- Every async boot, refresh, or mode-switch result commits only while its generation is current.
- Navigation jumps land at the fixed gaze point with `placeCursor(..., 'eye')` or `align: 'eye'`.
- `ReviewPane` resolves estimated jump layouts synchronously: scroll, `render(true)`, then reissue the measured offset before paint. Avoid cross-frame correction.
- Handled keys stop propagation in `useKeymap`; `CodeView` cancels pending scroll on propagated keydown.
- User input errors become `RevspecError`, `GitError`, `GithubError`, or Commander usage errors and exit 2; unexpected failures propagate.

## Renovate cleanly

- Drop backwards compatibility: replace old paradigms directly with cleaner solutions instead of adding shims or legacy support code. Rip off the bandaid; announce breaking changes in your output with `💥 Breaking: <explanation>`.

## Verify changes

- Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run format`, and `npm run build` before finishing; run `npm run test:e2e` after a client change.
- Prefer tests that produce something a reviewer can judge: a screenshot, an accessibility tree, a prompt, a payload. Server tests use temporary real Git repositories; e2e tests (`test/e2e/*.spec.ts`) drive a real diffle over the fixture repository (`test/fixture/repo.ts`) in Chromium and compare against snapshots under `__snapshots__/`; text outputs use `toMatchFileSnapshot`. Do not stub the viewer or the API in client tests: write an e2e scenario instead. The one exception is `test/client/store.test.ts`, whose deferred-promise races a browser cannot provoke reliably.
- The fixture repository hashes the same everywhere; `test/fixture/repo.test.ts` pins the hashes. Changing its history means updating the pins and re-accepting the screenshots that show it. `npm run fixture -- <dir>` builds it for hands-on testing.
- Screenshots are compared on Linux only, in Playwright's container in CI. Accept intended changes with `npm run test:e2e:update` locally to preview, then the `Update snapshots` workflow on the branch to regenerate them where CI compares them; the PR gets a snapshot report comparing before and after. `npm run test:e2e -- -g <pattern>` runs a few scenarios while iterating.
- Use `npm run dev -- working --no-open` for a local source run; restart after client changes because the server serves `dist/client`.
- CI runs the tests and the build on Linux, macOS, and Windows, x64 and arm64. `skipIf` what Windows cannot express, with a note: a `"` or a newline in a filename, POSIX mode bits, a POSIX-shell probe.
- Remove temp directories with `rmTmp` from `test/tmp.ts`: an idle `cat-file --batch` holds the repo root as its cwd, and Windows refuses to remove it until the child is reaped.
- Comments explain why in one or two lines. Exported doc comments state contracts, not implementations.

## Conventional commits

- Use conventional commits for commit messages and PR titles (e.g. `feat(cli): add pr command`, `fix(store): guard async commits`).
