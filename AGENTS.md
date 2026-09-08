# Working in diffle

Local git diff reviewer: Node server wraps git, React client renders diffs with `@pierre/diffs`, line comments export as an agent prompt. `README.md` has usage.

Asked to read or answer the human's review comments, or to get your own diff reviewed: run `diffle --skill` (`npx . --skill` in this checkout) and follow it. It covers the CLI end to end; the HTTP routes are a fallback, not the interface.

## Layout and boundaries

- `src/shared/protocol.ts` is the only code both sides import. Add a field there before using it on either side.
- `src/server/git/GitRepo.ts` is the only module that spawns git. Every call is a plumbing command with explicit args and `-z` output.
- `src/client/api.ts` is the only module that knows URLs.
- `src/server/Session.ts` owns the active mode: snapshotter, comment store, watcher. Mode switches are serialized; reads go through `readSide`, which enforces the snapshot path allowlist and maps a rename's old side to its old path.
- `src/client/store.ts` is one zustand store; `src/client/model.ts` holds the pure functions over its state (item ids, viewed state, ordering) so other modules can import them without a cycle. Every transition (boot, refresh, mode switch) carries a generation token; a result commits only while its token is current.
- Comments live in `<git-dir>/diffle/comments.json`, keyed by `ModeSpec.commentKey`. Nothing ever writes to the worktree or mutates the repo.

## Invariants that bite

- A rendered `FileDiffMetadata` is never mutated. Hydrate with `hydratePartialDiff('clone', …)` and replace the store entry; the item id embeds `gens[path]`, so a new generation gives the viewer a fresh renderer.
- `Snapshot.version` is monotonic across refreshes and mode switches. Bump it via `Session`, never by hand.
- `Snapshot.tree` describes the new side: the new commit's tree, or index plus untracked for the worktree. Ignored files and `.git` are never in it, and `/api/file` refuses anything outside it.
- Every jump (search `n`/`N`, `*`/`#`, references, `gd`, symbols, the jumplist) lands the target line on the fixed gaze point: `placeCursor(…, 'eye')` or `scrollTarget.align: 'eye'`, never `'start'`/`'nearest'`. The reader's eyes stay put and the code moves. Fresh or wrapped items lay out from estimates, so the scroll effect in `ReviewPane` lands a jump synchronously: `scrollTo`, then `render(true)` on the viewer instance so that frame measures and re-resolves before paint, then re-issue with the measured residue folded into the offset. Never correct a jump across frames: the reader sees every step. Handled keys stop propagating in `useKeymap`, because the viewer cancels its pending scroll on any keydown that reaches it.

## Commands

```bash
npm run dev -- working --no-open   # tsx + Vite middleware; the `--` is required before flags
npm test                           # vitest, real temp git repos, no mocks for git
npm run typecheck                  # two tsconfigs: server/node and client/DOM (test/client is client-side)
npm run build                      # dist/client + dist/server; the server serves dist/client when present
```

Done means all three pass. Tests for server behavior build a throwaway repo with `git init` in a tmpdir (see `test/server/Session.test.ts`); client store tests `vi.mock` `src/client/api.js` and race deferred promises.

## The agent skill

`diffle --skill` prints `SKILL` from `src/cli/skill.ts`: the guide an agent reads to drive a review (seed findings, read feedback, reply, resolve). It is a cache of the CLI surface, so it goes stale silently. Any change to `diffle comment`, to `--comment`/`--as`/`--background`, to the findings payload, or to the prompt format lands in `skill.ts` in the same commit; `test/cli/skill.test.ts` pins the names it mentions.

## Style

- Comments explain why, one or two lines. Doc comments on exported functions state the contract, not the implementation.
- Errors that are the user's fault (bad revspec, bad flag) become `RevspecError` / commander usage errors and exit 2; everything else propagates.
