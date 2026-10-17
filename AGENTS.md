# Working in diffle

Diffle is a local Git review app: a Node/Hono server owns repository state; a React client renders diffs with `@pierre/diffs`; comments can become an agent prompt or a pending GitHub review. Keep `README.md` focused on installation, core workflows, and user-visible constraints. Let `--help`, code, and tests carry exhaustive detail.

## Find the owner

- `src/shared/protocol.ts`: the only client/server contract. Define cross-boundary fields here first.
- `src/server/git/GitRepo.ts`: all Git execution. Use explicit argv and preserve stable, NUL-delimited parser inputs where applicable.
- `src/server/Session.ts`: active mode, snapshots, comments, watcher, and serialized transitions.
- `src/server/Snapshotter.ts`: derives trees, changed files, and patches for one mode.
- `src/server/routes.ts`: HTTP behavior; `src/server/ws.ts`: server-to-client invalidation messages.
- `src/server/comments/`: persistence, relocation, import, and prompt formatting.
- `src/server/github/`: `client.ts` resolves the token and wraps `@octokit/core` (the only GitHub transport; `gh` is spawned for `gh auth token` alone); `pulls.ts` names pull requests; `review.ts` exports pending reviews.
- `src/server/lsp/LspBridge.ts`: language-server process and JSON-RPC lifecycle.
- `src/client/api.ts`: the only client module that knows URLs.
- `src/client/store.ts`: Zustand state and effects; guard async commits with the current generation.
- `src/client/model.ts`: pure state functions and item identity, kept separate to avoid store cycles.
- `src/client/review/ReviewPane.tsx`: `CodeView` rendering, measurement, and scroll placement.
- `src/client/ui/dialog.tsx`, `tooltip.tsx`: shadcn components on Base UI (`components.json`, `@/` alias). We own them, restyled to the theme tokens; add another with `npx shadcn add`, then restyle it the same way. Not `button`: it would collide with `Button.tsx` on case-insensitive filesystems. `TipSurface` hangs a tip at a viewport box; `TitleTooltips` turns every `title` into one.
- `scripts/lib/quality-gate/`: the commit gate. `guards.ts` holds the pure rules, `tree.ts` reads the working tree, `run.ts` words the messages.

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
- The keymap runs the store's `escape()` on Escape and lets the key through, so a Base UI dialog also closes. A dialog whose Escape does more than close (References leaves a peek first) ignores the `escape-key` reason in `onOpenChange`.
- User input errors become `RevspecError`, `GitError`, `GithubError`, or Commander usage errors and exit 2; unexpected failures propagate.

## Renovate cleanly

- Drop backwards compatibility: replace old paradigms directly with cleaner solutions instead of adding shims or legacy support code. Rip off the bandaid; announce breaking changes in your output with `💥 Breaking: <explanation>`.

## Verify changes

- Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run format`, and `npm run build` before finishing.
- Never run the e2e tests (`npm run test:e2e*`) unprompted, not even after a client change. Run them only when the user asks or when you edited `test/e2e/`.
- Prefer tests that produce something a reviewer can judge: a screenshot, an accessibility tree, a prompt, a payload. Server tests use temporary real Git repositories; e2e tests (`test/e2e/*.spec.ts`) drive a real diffle over the fixture repository (`test/fixture/repo.ts`) in Chromium and compare against snapshots under `__snapshots__/`; text outputs use `toMatchFileSnapshot`. Do not stub the viewer or the API in client tests: write an e2e scenario instead. The one exception is `test/client/store.test.ts`, whose deferred-promise races a browser cannot provoke reliably.
- The fixture repository hashes the same everywhere; `test/fixture/repo.test.ts` pins the hashes. Changing its history means updating the pins and re-accepting the screenshots that show it. `npm run fixture -- <dir>` builds it for hands-on testing.
- Screenshots are compared on Linux only, in Playwright's container in CI. Run `npm run test:e2e:docker` on any host and inspect the persisted report with `npm run test:e2e:report`. Accept intended changes with `npm run test:e2e:docker:update` or the `Update snapshots` workflow; the PR gets a snapshot report comparing before and after. `npm run test:e2e:docker -- -g <pattern>` runs a few scenarios while iterating.
- When CI's e2e job fails, it regenerates the failed scenarios' snapshots and uploads them as the `e2e-snapshots` artifact. Commit them onto the PR's branch with `gh workflow run update-snapshots.yml -f pr=<number>` (it waits for the head commit's e2e job), follow it with `gh run watch "$(gh run list --workflow update-snapshots.yml --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId')"`, then `git pull`. Inspect the `e2e-results` artifact or the snapshot report before accepting. The bot's push reruns CI.
- The README GIF and diffle.app's videos are takes of real diffle: `npm run videos [-- <scene>]` (`scripts/record-videos.ts`) re-records them into `.github/assets/videos/`. Re-record the scenes a change alters (a shortcut, a moved control, a reworded hint) in the same PR and look at the frames; diffle.app copies them from the next release.
- Use `npm run dev -- working --no-open` for a local source run; restart after client changes because the server serves `dist/client`.
- CI runs the tests and the build on Linux, macOS, and Windows, x64 and arm64. `skipIf` what Windows cannot express, with a note: a `"` or a newline in a filename, POSIX mode bits, a POSIX-shell probe.
- Remove temp directories with `rmTmp` from `test/tmp.ts`: an idle `cat-file --batch` holds the repo root as its cwd, and Windows refuses to remove it until the child is reaped.
- Comments explain why in one or two lines. Exported doc comments state contracts, not implementations.

## Commit gate

- `npm install` points git at `.githooks` (the `prepare` script), and `.githooks/pre-commit` runs `scripts/quality-gate.ts` over the whole working tree. The CI `lint` job runs the same `npm run quality-gate`, so a `--no-verify` commit still fails there. The hook has no environment switch and fails when `node_modules` is missing.
- A source file stays within 330 lines, and a folder holds at most 15 source files. Tests (`*.test.*`, `*.spec.*`, and files under `test`, `tests`, `__tests__`, `e2e`, `fixtures`, `testdata`, `__snapshots__`), generated files, package roots and the repository root are never counted. Nothing requires a test for new code.
- Split along a real responsibility, never a line-count saw-cut. The only way past the gate is `.locignore` (files) or `.folderignore` (folders), one glob per line with `#` comments: a pattern without `/` matches the basename, one with `/` the whole path. List only a cohesive unit (generated code, a data catalog), with the reason on the same line. A `TODO` entry is debt: delete it when its file shrinks under the cap.

## Conventional commits

- Use conventional commits for commit messages and PR titles (e.g. `feat(cli): add pr command`, `fix(store): guard async commits`).
- Squash-merged PR titles become `CHANGELOG.md` entries and pick the next version (`cliff.toml`): a `!` bumps the minor version before 1.0, anything else the patch. The Release workflow keeps a `chore: release vX.Y.Z` PR open; merging it tags the release, and the tag publishes it. Never edit `CHANGELOG.md` or the version by hand.
