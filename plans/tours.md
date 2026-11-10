# Tours

A tour is a guided walkthrough of the reviewer's diff, written by their coding agent. Now that the CLI and the UI share one API surface (`diffle comments list` reaches the run through `<git-dir>/diffle/server.json`), the agent can read the diff, write one HTML document that explains it, and send it to the running diffle. Diffle renders it in a tour view, with diffle's styles applied. The agent composes the document from visual primitives diffle ships, such as a card holding a few lines of the diff with a short explanation and a button that jumps to those lines, or a file tree showing a directory layout. Scope: authoring format, primitives, delivery from the agent, storage, and the tour view. Out of scope until decided: editing a tour in the browser, several tours per review.

## Design decisions

### 1. Write a tour as an HTML subset with `diffle-*` elements, laid out on an open canvas

- **Chosen:** The agent writes one HTML document. Plain tags (`h1`–`h4`, `p`, `ul`, `ol`, `li`, `code`, `pre`, `strong`, `em`, `a`, `section`, `div`) carry prose and structure. Custom elements carry the primitives: `diffle-card`, `diffle-diff`, `diffle-tree`, `diffle-jump` (catalog: open question 1). The agent places and connects primitives on a pannable, zoomable canvas, as the graph view does (`src/client/graph/GraphCanvas.tsx`), rather than in one column of text.
- **Rejected:** Markdown with primitive fences (` ```diffle-diff path=… `) through `src/client/Markdown.tsx`. It is safe already and agents write it reliably, but it renders as one column, and the reviewer wants creative layouts that the agent connects freely.
- **Why:**
  - An explanation of a change is often a picture: a request flowing through three files, or one type feeding two callers.
  - HTML nests primitives inside cards and lets the agent group them.

### 2. Render the tour in the app from an allowlist, not in an iframe

- **Chosen:** The client parses the document with `DOMParser`. It maps each allowed tag to a React element and each `diffle-*` element to a component, and drops everything else: `script`, `style`, `iframe`, `img`, `on*` and `style` attributes, and links to anything but `http(s)`. Styling comes only from diffle's classes and the theme tokens in `src/client/styles/theme.css`, so light and dark both work.
- **Rejected:** A sandboxed iframe with diffle's stylesheet injected. It allows free-form CSS and isolates more strongly, but every primitive and every jump would have to cross `postMessage`, and the code in it couldn't use the app's `@pierre/diffs` worker pool and highlighter cache.
- **Why:**
  - A diff card can reuse `FileDiff` from `@pierre/diffs/react`, as `Markdown.tsx` does for suggestions.
  - A jump calls `store.jumpTo(path, line, side)` (`src/client/store.ts`) directly.
  - Tour HTML is untrusted, like a comment body. An allowlist makes "what can it do" a short list.

### 3. One tour per review, pushed by the agent and replaced on each push

- **Chosen:** `diffle tour push <file|->` sends the document to `PUT /api/tour`. It reaches the run through `reach` (`crates/diffle/src/cli/agent/server.rs`), as `diffle comments` does. The server keeps it in `<git-dir>/diffle/tours.json`, keyed by `Snapshot.commentKey`, and tells clients over `/ws`. A push replaces the review's tour. When the reviewer dislikes something or asks the agent a question, the agent revises the document and pushes again, and the open view updates in place.
- **Rejected:** Several named tours per review. They would let different agents, or a second pass, add to what's there, but they need list, select and delete commands in the CLI and a picker in the view.
- **Why:** One document per review keeps the CLI, the route and the view free of lists, and "revise and re-push" covers the reviewer's feedback loop.

### 4. A diff primitive references lines in the snapshot; it carries no patch text

- **Chosen:** `diffle-diff` takes `path`, `side` (`old` | `new`, default `new`) and a line range, the shape of `LineAnchorSchema` in `src/shared/protocol.ts`. The client cuts the lines from the review's patch for that path when it renders.
- **Rejected:** Pasting patch text into the element. It can't drift out of sync with itself, but it can quietly disagree with the real diff, needs a second parser, and makes the document large.
- **Why:** The card always shows the real, current diff, highlighted like the diff view. A jump and the card it sits in name the same lines.
- **Cost:** A card can go stale when a refresh moves or drops its lines (see decision 8).

### 5. The agent declares cards and edges; diffle lays them out

- **Chosen:** Each top-level `diffle-card` has an `id`. `<diffle-edge from="<id>" to="<id>" label="…">` connects two cards, and `diffle-group` boxes related cards under a title (a layer, a package). Diffle places them with the layered layout from the graph view (`src/client/graph/layout/rank.ts`, `order.ts`, `layout.ts`), sizing each card by its rendered contents.
- **Rejected:** Coordinates (`x`/`y`, or grid row and column) on each card. The agent can't know a card's rendered height, which depends on its diff lines and prose, so cards would overlap or leave gaps, and each fix would cost another push.
- **Why:** The agent states structure, which it knows. Diffle handles geometry, which it can measure.
- **Revisit when:** tours need exact placement. A `rank` hint on a card could pin its layer (Follow-ups).

### 6. A tour is an ordered walk: numbered steps the reviewer steps through

- **Chosen:** A card can carry `step="<n>"`, and the card shows its number. `n` and `p` move to the next and previous step, and the canvas glides to that card, as the graph view's focus does. A card without `step` is context the reviewer reaches by panning or by an edge.
- **Rejected:** A free canvas with no order. The keymap stays smaller, but on a large canvas the reviewer has to guess where to begin.
- **Why:** A tour exists to give the reviewer a high-level walk through the change. The order the agent picks is part of the explanation, and walking it step by step is the main way to read it.

### 7. The reviewer's feedback goes to the agent's own chat in v1

- **Chosen:** Tour cards are not comment anchors. The reviewer tells their agent what to change or asks it questions in the agent's own session, and the agent pushes a revised tour (decision 3). Comments on the actual lines still go through the diff view and the existing threads.
- **Rejected:** Comments on tour cards as threads the agent reads through `/api/threads/activity`. They would keep the conversation in diffle, but need a `tour` anchor in `CommentAnchorSchema` that GitHub export and the prompt format must skip.
- **Why:** No new anchor kind, and nothing changes for export.
- **Revisit when:** reviewers want to ask questions about a card without leaving diffle (Follow-ups).

### 8. A tour survives refreshes; a card whose lines left the diff says so in place

- **Chosen:** The tour stays under its `commentKey` across `Snapshot.version` changes. Each `diffle-diff` resolves against the current snapshot when it renders: the client cuts its lines from the file's patch and its text on that side (`src/client/tour/excerpt.ts`). When its lines are gone (the file left that side, or the range runs past its end), the card shows a stale notice in place of the lines, and its jump still goes to the file. The view's header counts the stale cards.
- **Rejected:** Dropping the tour, or marking all of it stale, once the snapshot moves past the version it was pushed against. Simpler, and it never shows outdated prose, but one fixup commit would wipe out a tour the reviewer was halfway through.
- **Why:** The agent keeps editing code while the tour is open, and most cards keep their lines. The stale count tells the reviewer when to ask for a fresh push.

### 9. Eight primitives in v1, all structure and no styling knobs

- **Chosen:**

  | Element          | Attributes                                                         | Shows                                                                                                                           |
  | ---------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
  | `diffle-card`    | `id`, `step?`, `title`                                             | a box of prose and primitives; a node on the canvas, with its step number when it has one                                       |
  | `diffle-group`   | `title`                                                            | a frame around related cards                                                                                                    |
  | `diffle-edge`    | `from`, `to`, `label?`                                             | an arrow between two cards                                                                                                      |
  | `diffle-diff`    | `path`, `side?` (`old` \| `new`, default `new`), `lines` (`40-58`) | those diff lines, highlighted, with a jump to them                                                                              |
  | `diffle-tree`    | `paths` (newline-separated), `root?`                               | a directory tree; changed files carry their status from the snapshot                                                            |
  | `diffle-jump`    | `path`, `line?`, `side?`                                           | a button into the diff view                                                                                                     |
  | `diffle-symbol`  | `path`, `line`, `name`, `side?`                                    | a chip for the symbol `name` on that line; it opens the language server's references, like the references peek in the diff view |
  | `diffle-callout` | `kind` (`note` \| `warning`)                                       | a highlighted aside inside a card                                                                                               |

- **Rejected:** Styling attributes (colours, sizes, widths). Theme tokens and the layout cover them, and every knob is one more thing the agent can get wrong.
- **Why:** These answer "what changed, where, and how it connects", and a small catalog is one an agent learns reliably.
- **Constraint:** `diffle-symbol` depends on the language servers. When `lspBlocker` (`src/shared/lsp.ts`) returns a reason, the chip renders as plain code, and its tooltip gives that reason. Servers answer for the new side only, so a symbol on the old side is always plain code. A click finds the name on its line as a whole word, asks `POST /api/lsp/references`, and opens the references list the diff's `gA` opens.

### 10. The server validates a pushed tour; a bad one fails the CLI with exit 2

- **Chosen:** `PUT /api/tour` parses the document in Rust with `html5ever` (MIT OR Apache-2.0, both in `about.toml`'s `accepted`), through a small arena tree sink of its own (`tour/dom.rs`; `markup5ever_rcdom` is test-only by its authors' word), so the validator sees the tree `DOMParser` builds. It refuses:
  - unknown elements and attributes, and any attribute on a plain tag but an `http(s)` `href` on `a`
  - an element where it may not sit: cards at the top level or in a group, groups and edges at the top level, the other primitives inside a card, text and plain tags inside a card
  - content in an element that holds none (`diffle-edge`, `diffle-diff`, `diffle-tree`, `diffle-symbol`), which is what `<diffle-edge ... />` produces, since HTML ignores `/>` there
  - an edge whose `from` or `to` names no card
  - a duplicate `id` or `step`
  - a `path` outside the snapshot on the side it names, or a tree path outside its `root`
  - a line range past the end of its file on that side
  - a `diffle-symbol` whose `name` isn't on its line as a whole word
  - a document without a card

  Each error names the element and the reason. A refusal is a user error (`Error::is_user_error`), so `diffle tour push` exits 2 with the list, and the agent fixes the document and pushes again. The client still applies its own allowlist when rendering (decision 2).

- **Rejected:** Storing any document and letting the client drop what it doesn't know. The agent would never learn that a card vanished or an edge dangles, and the reviewer would get a broken tour.
- **Why:** The agent writes and pushes in a loop, so the CLI's exit status and stderr are its only feedback.
- **Cost:** A new dependency, plus an allowlist on each side of the contract; decision 11 gives both one source.

### 11. `protocol.ts` defines the catalog; the client, the validator and the agent's documentation all read it

- **Chosen:** In `src/shared/protocol.ts`, each `diffle-*` element is a `.strict()` zod object of its attributes, documented with JSDoc. `TourElementSchema` is their discriminated union on `tag`, and `TourTagSchema` is a `z.enum` of the plain tags. They cross to Rust like the rest of the contract (`protocol.generated.json`, `build.rs`). The validator (decision 10) turns each parsed element into `{tag, ...attributes}` and deserializes it into `crate::protocol::TourElement`, so an unknown tag or attribute fails there. Cross-element rules (edge targets, unique ids and steps, paths, symbol names) stay in Rust. The client builds its allowlist (decision 2) from the same schemas. The agent documentation (decision 13) prints the catalog from the schemas' descriptions, with one example document and the authoring rules: the order is part of the explanation, and cards stay short.
- **Rejected:**
  - A Rust table in `crates/diffle/src/tour/catalog.rs` plus a Node test comparing it with a TypeScript copy. Two hand-kept copies, and a test whose only job is to catch drift between them.
  - A separate, hand-written skill file or `AGENTS.md` snippet. It would drift from the running diffle and needs an install step.
- **Why:**
  - `protocol.ts` is already the only client/server contract, so this adds no new mechanism.
  - What the agent reads can't disagree with what the validator enforces.
- **Constraint:** HTML attribute values are strings, so the attribute schemas use strings: `z.enum` for `side` and `kind`, and a regex for `step` and `lines`. A `.strict()` object exports `additionalProperties: false`, which typify 0.8 turns into `#[serde(deny_unknown_fields)]` (verified in `typify-impl-0.8.0/src/structs.rs`; `crates/diffle/Cargo.toml` pins `typify = "0.8"`).

### 12. Share the canvas with the graph view; the tour is a third `ViewDef`

- **Chosen:** Move the viewport (pan, zoom, fit, eased focus) and the arrow shapes out of `src/client/graph/GraphCanvas.tsx` and `GraphShapes.tsx` into `src/client/canvas/`. Generalize `src/client/graph/layout/` from `GraphNode` to nodes with only an `id`, given a size and an optional cluster (the box a layer's members share: a file for the graph, a `diffle-group` for a tour) by the caller, and move it into `src/client/canvas/layout/`. What only the graph knows stays in `graph/layout/`: its parts (`components.ts`) and source order (`source.ts`). Register `tourView` in `src/client/views/registry.ts` with `id: 'tour'`. Its `blocked` returns a reason while the review has no tour, and the header's view switch lists it only while there is one (`ViewDef.useListed`), so reviews without tours look as before. Its `keys` take `n` and `p` for steps (decision 6). `T` toggles it (`toggleView('tour')` in `src/client/keyboard/useKeymap.ts`, next to `M` for the graph); in the graph view `T` stays the tests filter. On the canvas a `diffle-group` is the layout's cluster: a group ranks as one unit, so its cards share a layer and one frame.
- **Rejected:** A separate, simpler canvas and layout for tours. It ships faster, but two canvases drift apart in pan, zoom and keys.
- **Why:** One canvas behaviour, and one set of canvas keys, across both views.
- **Cost:** A refactor of the graph view lands inside this feature, so the graph's e2e screenshots must stay unchanged.

### 13. `diffle --skill` prints the agent interface as Markdown, with no frontmatter

- **Chosen:** A top-level `--skill` flag, declared `exclusive = true` in `crates/diffle/src/cli/args.rs` so clap refuses it alongside a revision or any review option. It prints the whole agent interface to stdout: how to reach the run, `diffle comments`, `diffle tour push` and `clear`, and the catalog (decision 11). The output has no frontmatter. The user wraps it in their own and installs it under the name and description they choose.
- **Rejected:**
  - A `diffle skill` subcommand. It sits next to `comments`, `config` and `lsp`, but the user prefers the flag. `exclusive` removes the one concern: `diffle main --skill` would otherwise parse.
  - Output with `name`/`description` frontmatter. It would fix a skill name and description that users want to pick themselves.
- **Why:** One command an agent can run to learn everything diffle offers it, always matching the binary that answers.

### 14. The tour view's side panel is the step outline

- **Chosen:** `ViewDef.Side` lists the steps in order with their number and card title, marks stale cards (decision 8), and highlights the current step. Clicking a step glides to its card.
- **Rejected:** Details of the selected card, like the graph view's `GraphDetails`. They would repeat what the card already shows.
- **Why:** The walk is the main way to read a tour (decision 6). The outline shows where the reviewer is in it and how much remains.

### 15. Only the agent removes a tour; old tours stay on disk

- **Chosen:** `diffle tour clear` removes the review's tour (`DELETE /api/tour`). The view has no delete button. `tours.json` keeps the tours of reviews that are gone, as `comments.json` keeps old comment sets.
- **Rejected:** A delete button in the view, and pruning keys of reviews not opened for N days.
- **Why:**
  - The agent owns the tour, and a stray click in the view can't throw it away.
  - Pruning would be new behaviour that `comments.json` doesn't have either.

### 16. A tour travels as JSON in the generated contract

- **Chosen:** `PUT /api/tour` takes `TourPush {html}` and answers `Tour {html, pushedAt, version}`, or 422 with `TourRejection {errors: [{element, message}]}`. `version` is the `Snapshot.version` the tour was pushed against. `element` names the culprit so the agent can find it in its document: its tag and attributes as written, after the card it sits in (`diffle-card#auth > diffle-diff path="a.rs" lines="3-9"`). `GET /api/tour` answers `TourResponse {tour: Tour | null}`. `DELETE /api/tour` answers 204. A new `ServerMessage {type: 'tour'}` tells clients to refetch, like `viewed`.
- **Rejected:** A raw `text/html` body on `PUT`. It can be `curl`ed straight from a file, but `diffle tour push` already does that for the agent, and a raw body leaves the generated contract and leaves no room for fields later.
- **Why:** Every cross-boundary shape lives in `protocol.ts`.

### 17. Tours get their own module, beside `comments/`

- **Chosen:** `crates/diffle/src/tour/` (`store.rs`, `validate.rs`), `crates/diffle/src/server/routes/tour.rs`, and `crates/diffle/src/cli/agent/tour.rs`. The routes reach the store through `Session::tour()`, which mirrors `Session::comments()`. The store writes under the file lock and atomically through `crate::persist`, as `CommentStore` (`crates/diffle/src/comments/store.rs`) does.
- **Rejected:** Living under `comments/`. A tour isn't a comment, and the shared parts (key, lock, atomic write) are small.
- **Why:** The comments module stays untouched and within the line caps.

### 18. Ship in five slices, the server first

- **Chosen:** The order under **Delivery**.
- **Rejected:** The canvas refactor first. It front-loads risk to the graph view while nothing depends on it yet.
- **Why:** An agent can push and get refusals before any UI exists, which tests the catalog and the validator early.

## Context for the implementer

- The agent runs in the reviewer's worktree, next to a running diffle. It reaches the server the way `diffle comments` does (`crates/diffle/src/cli/agent/server.rs`, `reach`).
- The reviewer opens the tour, reads it top to bottom, and jumps from a card into the diff view, which keeps its own scroll (`src/client/views/state.ts`: views stay mounted).
- Tour HTML is written by an agent that read repository content, so it is untrusted, like a comment body (`src/client/Markdown.tsx` drops raw HTML and images for that reason).

## Interfaces and files

CLI:

```
diffle tour push [<file>|-] [-C <path>]   # PUT /api/tour; prints Tour as JSON; exit 2 with the errors on 422
diffle tour clear [-C <path>]             # DELETE /api/tour
diffle --skill                            # prints the agent interface as Markdown; exclusive
```

```
src/shared/protocol.ts                         MODIFIED  Tour, TourPush, TourResponse, TourRejection, TourElement (+ one strict attribute schema per diffle-* element), TourTag, ServerMessage 'tour'
crates/diffle/protocol.generated.json          MODIFIED  regenerated (npx vitest run test/scripts/protocol-schema.test.ts -u)
crates/diffle/Cargo.toml                       MODIFIED  html5ever
crates/diffle/src/tour/mod.rs                  NEW       module root
crates/diffle/src/tour/store.rs                NEW       <git-dir>/diffle/tours.json, one tour per commentKey
crates/diffle/src/tour/dom.rs                  NEW       html5ever into an arena tree, as DOMParser builds it
crates/diffle/src/tour/validate.rs             NEW       check against TourElement and TourTag, placement, cross-element rules (decision 10)
crates/diffle/src/tour/files.rs                NEW       what elements ask of the review's files, checked against the snapshot
crates/diffle/src/session/mod.rs               MODIFIED  Session::tour()
crates/diffle/src/server/routes/tour.rs        NEW       GET/PUT/DELETE /api/tour, broadcasts 'tour'
crates/diffle/src/server/routes/mod.rs         MODIFIED  mount tour routes
crates/diffle/src/cli/args.rs                  MODIFIED  Tour { Push, Clear }, --skill
crates/diffle/src/cli/agent/tour.rs            NEW       push and clear through reach()
crates/diffle/src/cli/skill.rs                 NEW       renders the agent interface and the catalog
crates/diffle/tests/tour.rs                    NEW       push, rejection, clear, refresh survival; insta snapshots
src/client/api.ts                              MODIFIED  tour(), on 'tour' refetch
src/client/canvas/                             NEW       viewport, arrows, layout moved from graph/ (decision 12)
src/client/graph/GraphCanvas.tsx, layout/      MODIFIED  use canvas/
src/client/tour/view.ts                        NEW       tourView ViewDef: blocked, keys n/p, place
src/client/tour/TourCanvas.tsx                 NEW       lays out cards, groups and edges on the canvas
src/client/tour/document.ts                    NEW       DOMParser → cards, groups, arrows and steps, through the catalog's schemas
src/client/tour/render.tsx                     NEW       a card's contents → allowlisted React (decision 2)
src/client/tour/excerpt.ts                     NEW       a diff primitive's lines as a one-hunk patch, numbered as in the file
src/client/tour/state.ts                       NEW       the tour, the step shown, stale cards, per-snapshot file reads
src/client/tour/primitives/                    NEW       Card, Diff, Tree, Jump, Symbol, Callout (groups and edges are drawn by TourCanvas)
src/client/tour/StepOutline.tsx                NEW       side panel (decision 14)
src/client/views/registry.ts, state.ts         MODIFIED  register 'tour'; ViewId gains 'tour'; ViewDef.useListed
src/client/views/ViewSwitch.tsx                MODIFIED  leaves out a view its useListed declines
src/client/keyboard/useKeymap.ts, HelpOverlay  MODIFIED  T toggles the tour view; help rows
test/e2e/tour.spec.ts                          NEW       pushes a tour over the fixture repository; screenshots
```

## Delivery

1. Protocol, store, validator, routes, `diffle tour push`/`clear`. Verify: `pixi run test-rust`, `pixi run test-node`.
2. Move the canvas into `src/client/canvas/`; the graph view's behaviour doesn't change. Verify: `pixi run test-node`, `pixi run e2e -g graph` with no screenshot changes.
3. The tour view: cards, groups, edges, `diff`, `jump`, `tree`, `callout`, steps, `n`/`p`, outline, stale notice. Verify: `pixi run e2e -g tour`.
4. `diffle-symbol` through the language-server pool. Verify: `pixi run test-rust`, `pixi run e2e -g tour`.
5. `diffle --skill`. Verify: an insta snapshot of its output in `pixi run test-rust`.

Each slice ends with `pixi run lefthook-run` and `pixi run build-release`.

## Open questions

None.

## Follow-ups

- A `rank` hint on a card that pins its layer, for when auto-layout misplaces a card the agent cares about (decision 5).
- Comments on tour cards that reach the agent through diffle, for when reviewers want answers without leaving diffle (decision 7).
