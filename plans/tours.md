# Tours

A tour is a guided walkthrough of the reviewer's diff, written by their coding agent. Now that the CLI and the UI share one API surface (`diffle comments list` reaches the run through `<git-dir>/diffle/server.json`), the agent can read the diff, write one HTML document that explains it, and send it to the running diffle. Diffle renders it in a tour view, with diffle's styles applied. The agent composes the document from visual primitives diffle ships, such as a card holding a few lines of the diff with a short explanation and a button that jumps to those lines, or a file tree showing a directory layout. Scope: authoring format, primitives, delivery from the agent, storage, and the tour view. Out of scope until decided: editing a tour in the browser, several tours per review.

## Design decisions

### 1. Write a tour as an HTML subset with `diffle-*` elements, read as one scrolling page

- **Chosen:** The agent writes one HTML document. Plain tags (`h1`–`h4`, `p`, `ul`, `ol`, `li`, `code`, `pre`, `strong`, `em`, `a`, `section`, `div`, and tables: `table`, `thead`, `tbody`, `tr`, `th`, `td`) carry prose and structure. Custom elements carry the primitives (decision 9). Diffle shows the cards as one vertically scrolling page, in step order (decision 6). A picture of how parts connect is a `diffle-diagram` inside a card.
- **Rejected:**
  - Markdown with primitive fences (` ```diffle-diff path=… `) through `src/client/Markdown.tsx`. It is safe already and agents write it reliably, but it has no cards, groups or steps.
  - A pannable, zoomable canvas of cards joined by arrows, as the graph view draws (`src/client/graph/GraphCanvas.tsx`). It was built first and dropped: the reviewer found it looked too much like the graph view and wanted a page, with cards wide enough that diff lines don't wrap. Arrows between cards also collided with group frames.
- **Why:**
  - A page reads top to bottom like a walkthrough, and its cards can take the full width.
  - HTML nests primitives inside cards and lets the agent group them; a diagram carries the pictures the canvas's arrows were for.

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

### 5. The agent declares cards and groups; diffle orders them on the page

- **Chosen:** Each `diffle-card` has a unique `id`, and `diffle-group` puts related cards in a titled section (a layer, a package). The page reads the steps in order, then the cards without one in document order; a group stays one section, placed at its first step, its stepped cards before the rest (`pageOrder` in `src/client/tour/document.ts`). Relations between cards go in the prose or a `diffle-diagram`.
- **Rejected:**
  - `diffle-edge`, an arrow between two cards. A page can't draw arrows between cards cleanly.
  - Coordinates on each card. The agent can't know a card's rendered height, so cards would overlap or leave gaps.
- **Why:** The agent states order and grouping, which it knows; diffle handles the geometry.

### 6. A tour is an ordered walk: numbered steps the reviewer steps through

- **Chosen:** A card can carry `step="<n>"`, and the card shows its number. `n` and `p` move to the next and previous step and scroll its card to the gaze point: centred when it fits, its top near the page's top when it is taller. A card without `step` is context, after the steps. `j`/`k` and `d`/`u` scroll the page.
- **Rejected:** No order at all. The reviewer would have to guess where to begin.
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

  | Element          | Attributes                                                         | Shows                                                                                                                  |
  | ---------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
  | `diffle-card`    | `id`, `step?`, `title`                                             | a box of prose and primitives on the page, with its step number when it has one                                        |
  | `diffle-group`   | `title`                                                            | a titled section around related cards                                                                                  |
  | `diffle-diff`    | `path`, `side?` (`old` \| `new`, default `new`), `lines` (`40-58`) | those diff lines, highlighted, with a jump to them                                                                     |
  | `diffle-tree`    | `paths` (newline-separated), `root?`                               | a directory tree; changed files carry their status from the snapshot                                                   |
  | `diffle-jump`    | `path`, `line?`, `side?`                                           | a button into the diff view                                                                                            |
  | `diffle-symbol`  | `path`, `line`, `name`, `side?`                                    | the symbol `name`, coloured as the diff colours it on that line; it hovers and lists references like the diff's tokens |
  | `diffle-callout` | `kind` (`note` \| `warning`)                                       | a highlighted aside inside a card                                                                                      |
  | `diffle-diagram` | none; holds one `<svg viewBox>`                                    | a simple architecture diagram the agent draws by hand, styled by diffle                                                |

- **Rejected:** Styling attributes (colours, sizes, widths). Theme tokens and the layout cover them, and every knob is one more thing the agent can get wrong.
- **Why:** These answer "what changed, where, and how it connects", and a small catalog is one an agent learns reliably. Cards share the page column's width, 896 pixels, so a diff line of about 100 characters doesn't wrap.
- **Diagrams:** `TourSvgElementSchema` allows `svg` (`viewBox="0 0 <w> <h>"`), `g`, `rect`, `circle`, `ellipse`, `polygon`, `path`, `line`, `polyline`, `text` and `tspan`, each with its geometry and a `class`. `TourSvgClassSchema` is the vocabulary, a subset of the svg-diagram skill's: `arrow`, `arrows`, `dashed`; `bold`, `small`, `mono`, `c`, `e`, `eyebrow`; `fill`, `frame`; `accent`, `success`, `warning`, `error`. `src/client/styles/diagram.css` styles them from the theme tokens, and `src/client/tour/primitives/Diagram.tsx` redraws only what the catalog allows and adds arrowheads in each line's tone. A table compares or maps; a diagram shows how parts connect.
- **Constraint:** `diffle-symbol` takes its colour from `highlightLines` (`src/client/lsp/highlight.tsx`), the shared highlighter and theme that lists outside the diff use, over its line alone, so it needs no language server and works on the old side. Hover and references depend on the language servers. When `lspBlocker` (`src/shared/lsp.ts`) returns a reason, the chip stays coloured code without hover, and its tooltip gives that reason. Servers answer for the new side only, so a symbol on the old side never hovers. Hovering goes through the diff's own `hoverControl` and `HoverTooltip` (`src/client/lsp/HoverTooltip.tsx`) and the store's `requestHover`. A click finds the name on its line as a whole word, asks `POST /api/lsp/references`, and opens the references list the diff's `gA` opens. `diffle --skill` tells agents to mark every symbol their prose names this way and keep `<code>` for paths, commands and literals.

### 10. The server validates a pushed tour; a bad one fails the CLI with exit 2

- **Chosen:** `PUT /api/tour` parses the document in Rust with `html5ever` (MIT OR Apache-2.0, both in `about.toml`'s `accepted`), through a small arena tree sink of its own (`tour/dom.rs`; `markup5ever_rcdom` is test-only by its authors' word), so the validator sees the tree `DOMParser` builds. It refuses:
  - unknown elements and attributes, and any attribute on a plain tag but an `http(s)` `href` on `a` and a positive `colspan` or `rowspan` on `th` and `td`
  - an element where it may not sit: cards at the top level or in a group, groups at the top level, the other primitives inside a card, text and plain tags inside a card
  - content in an element that holds none (`diffle-diff`, `diffle-tree`, `diffle-symbol`), which is what `<diffle-diff ... />` produces, since HTML ignores `/>` there
  - in a `diffle-diagram` (`tour/diagram.rs`): anything but one `<svg>`; an element or class outside the diagram catalog; `style`, `fill`, `stroke`, font, marker and other styling attributes; `<defs>` and markers (diffle draws the arrowheads); a `tspan` outside a `text`; an `<svg>` outside a diagram
  - a duplicate `id` or `step`
  - a `path` outside the snapshot on the side it names, or a tree path outside its `root`
  - a line range past the end of its file on that side
  - a `diffle-symbol` whose `name` isn't on its line as a whole word
  - a document without a card

  Each error names the element and the reason. A refusal is a user error (`Error::is_user_error`), so `diffle tour push` exits 2 with the list, and the agent fixes the document and pushes again. The client still applies its own allowlist when rendering (decision 2).

  An accepted push can carry warnings in the same `{element, message}` shape, which `diffle tour push` prints to stderr while it exits 0. They are judgment calls from a diagram's geometry (`tour/layout.rs`), against the layout rules `--skill` gives: a label that may be wider than its box or run past it (the per-character estimate, so the message says "may"), a lone label off its box's vertical middle, a rect off the 8-unit grid or past the drawing's edge, a drawing wider than the limit, more than about a third of the shapes toned. Refusing these was rejected: the estimate can be wrong, and the agent can judge.

- **Rejected:** Storing any document and letting the client drop what it doesn't know. The agent would never learn that a card or a diagram vanished, and the reviewer would get a broken tour.
- **Why:** The agent writes and pushes in a loop, so the CLI's exit status and stderr are its only feedback.
- **Cost:** A new dependency, plus an allowlist on each side of the contract; decision 11 gives both one source.

### 11. `protocol.ts` defines the catalog; the client, the validator and the agent's documentation all read it

- **Chosen:** In `src/shared/protocol.ts`, each `diffle-*` element is a `.strict()` zod object of its attributes, documented with JSDoc. `TourElementSchema` is their discriminated union on `tag`, and `TourTagSchema` is a `z.enum` of the plain tags. They cross to Rust like the rest of the contract (`protocol.generated.json`, `build.rs`). The validator (decision 10) turns each parsed element into `{tag, ...attributes}` and deserializes it into `crate::protocol::TourElement`, so an unknown tag or attribute fails there. `TourSvgElementSchema` and `TourSvgClassSchema` do the same for a diagram's `<svg>`. Cross-element rules (unique ids and steps, paths, symbol names) stay in Rust. The client builds its allowlist (decision 2) from the same schemas. The agent documentation (decision 13) prints the catalog from the schemas' descriptions, with one example document and the authoring rules: the order is part of the explanation, and cards stay short.
- **Rejected:**
  - A Rust table in `crates/diffle/src/tour/catalog.rs` plus a Node test comparing it with a TypeScript copy. Two hand-kept copies, and a test whose only job is to catch drift between them.
  - A separate, hand-written skill file or `AGENTS.md` snippet. It would drift from the running diffle and needs an install step.
- **Why:**
  - `protocol.ts` is already the only client/server contract, so this adds no new mechanism.
  - What the agent reads can't disagree with what the validator enforces.
- **Constraint:** HTML attribute values are strings, so the attribute schemas use strings: `z.enum` for `side` and `kind`, and a regex for `step` and `lines`. A `.strict()` object exports `additionalProperties: false`, which typify 0.8 turns into `#[serde(deny_unknown_fields)]` (verified in `typify-impl-0.8.0/src/structs.rs`; `crates/diffle/Cargo.toml` pins `typify = "0.8"`).

### 12. The tour is a third `ViewDef`, a page of its own; the graph view is untouched

- **Chosen:** `src/client/tour/TourPage.tsx` renders the page. Register `tourView` in `src/client/views/registry.ts` with `id: 'tour'`. Its `blocked` returns a reason while the review has no tour, and the header's view switch lists it only while there is one (`ViewDef.useListed`), so reviews without tours look as before. Its `keys` take `n` and `p` for steps and `j`/`k`/`d`/`u` to scroll (decision 6). `T` toggles it (`toggleView('tour')` in `src/client/keyboard/useKeymap.ts`, next to `M` for the graph); in the graph view `T` stays the tests filter.
- **Rejected:** Sharing the graph's canvas (`src/client/canvas/`, the viewport and a generalized layered layout). It was built for the canvas tour and reverted with it (decision 1); the graph's code is as on `main`.
- **Why:** A page needs no viewport or layout, so the graph view has nothing to share.

### 13. `diffle --skill` prints the agent interface as Markdown, with no frontmatter

- **Chosen:** A top-level `--skill` flag, declared `exclusive = true` in `crates/diffle/src/cli/args.rs` so clap refuses it alongside a revision or any review option; `exclusive` does not cover subcommands, so `cli/mod.rs` refuses `--skill` with one as a usage error. It prints the whole agent interface to stdout: how to reach the run, `diffle comments`, `diffle tour push` and `clear`, and the catalog (decision 11). The output has no frontmatter. The user wraps it in their own and installs it under the name and description they choose.
- **Rejected:**
  - A `diffle skill` subcommand. It sits next to `comments`, `config` and `lsp`, but the user prefers the flag. `exclusive` removes the one concern: `diffle main --skill` would otherwise parse.
  - Output with `name`/`description` frontmatter. It would fix a skill name and description that users want to pick themselves.
- **Why:** One command an agent can run to learn everything diffle offers it, always matching the binary that answers.

### 14. The tour view's side panel is the step outline

- **Chosen:** `ViewDef.Side` lists the steps in order with their number and card title, marks stale cards (decision 8), and highlights the current step. Clicking a step scrolls to its card.
- **Rejected:** Details of the selected card, like the graph view's `GraphDetails`. They would repeat what the card already shows.
- **Why:** The walk is the main way to read a tour (decision 6). The outline shows where the reviewer is in it and how much remains.

### 15. Only the agent removes a tour; old tours stay on disk

- **Chosen:** `diffle tour clear` removes the review's tour (`DELETE /api/tour`). The view has no delete button. `tours.json` keeps the tours of reviews that are gone, as `comments.json` keeps old comment sets.
- **Rejected:** A delete button in the view, and pruning keys of reviews not opened for N days.
- **Why:**
  - The agent owns the tour, and a stray click in the view can't throw it away.
  - Pruning would be new behaviour that `comments.json` doesn't have either.

### 16. A tour travels as JSON in the generated contract

- **Chosen:** `PUT /api/tour` takes `TourPush {html}` and answers `TourPushed {tour: Tour {html, pushedAt, version}, warnings}`, or 422 with `TourRejection {errors: [{element, message}]}`. `version` is the `Snapshot.version` the tour was pushed against. `element` names the culprit so the agent can find it in its document: its tag and attributes as written, after the card it sits in (`diffle-card#auth > diffle-diff path="a.rs" lines="3-9"`). `GET /api/tour` answers `TourResponse {tour: Tour | null}`. `DELETE /api/tour` answers 204. A new `ServerMessage {type: 'tour'}` tells clients to refetch, like `viewed`.
- **Rejected:** A raw `text/html` body on `PUT`. It can be `curl`ed straight from a file, but `diffle tour push` already does that for the agent, and a raw body leaves the generated contract and leaves no room for fields later.
- **Why:** Every cross-boundary shape lives in `protocol.ts`.

### 17. Tours get their own module, beside `comments/`

- **Chosen:** `crates/diffle/src/tour/` (`store.rs`, `validate.rs`), `crates/diffle/src/server/routes/tour.rs`, and `crates/diffle/src/cli/agent/tour.rs`. The routes reach the store through `Session::tour()`, which mirrors `Session::comments()`. The store writes under the file lock and atomically through `crate::persist`, as `CommentStore` (`crates/diffle/src/comments/store.rs`) does.
- **Rejected:** Living under `comments/`. A tour isn't a comment, and the shared parts (key, lock, atomic write) are small.
- **Why:** The comments module stays untouched and within the line caps.

### 18. Ship in slices, the server first

- **Chosen:** The order under **Delivery**.
- **Rejected:** The UI first. Without the validator, nothing tells the agent what it got wrong.
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
src/shared/protocol.ts                         MODIFIED  Tour, TourPush, TourResponse, TourRejection, TourElement (+ one strict attribute schema per diffle-* element), TourTag, TourSvgElement, TourSvgClass, ServerMessage 'tour'
crates/diffle/protocol.generated.json          MODIFIED  regenerated (npx vitest run test/scripts/protocol-schema.test.ts -u)
crates/diffle/Cargo.toml                       MODIFIED  html5ever
crates/diffle/src/tour/mod.rs                  NEW       module root
crates/diffle/src/tour/store.rs                NEW       <git-dir>/diffle/tours.json, one tour per commentKey
crates/diffle/src/tour/dom.rs                  NEW       html5ever into an arena tree, as DOMParser builds it
crates/diffle/src/tour/validate.rs             NEW       check against TourElement and TourTag, placement, cross-element rules (decision 10)
crates/diffle/src/tour/files.rs                NEW       what elements ask of the review's files, checked against the snapshot
crates/diffle/src/tour/element.rs              NEW       reads an element's attributes through the catalog; names it in errors
crates/diffle/src/tour/diagram.rs              NEW       checks a diffle-diagram's svg against TourSvgElement and TourSvgClass
crates/diffle/src/session/mod.rs               MODIFIED  Session::tour()
crates/diffle/src/server/routes/tour.rs        NEW       GET/PUT/DELETE /api/tour, broadcasts 'tour'
crates/diffle/src/server/routes/mod.rs         MODIFIED  mount tour routes
crates/diffle/src/cli/args.rs                  MODIFIED  Tour { Push, Clear }, --skill
crates/diffle/src/cli/agent/tour.rs            NEW       push and clear through reach()
crates/diffle/src/cli/skill.rs                 NEW       renders the agent interface and the catalog
crates/diffle/tests/tour.rs                    NEW       push, rejection, clear, refresh survival; insta snapshots
src/client/api.ts                              MODIFIED  tour(), on 'tour' refetch
src/client/tour/view.ts                        NEW       tourView ViewDef: blocked, keys n/p and scrolling, place
src/client/tour/TourPage.tsx                   NEW       the page: sections in reading order, a step scrolled to the gaze point
src/client/tour/document.ts                    NEW       DOMParser → cards, groups and steps through the catalog's schemas; pageOrder
src/client/tour/render.tsx                     NEW       a card's contents → allowlisted React (decision 2)
src/client/tour/excerpt.ts                     NEW       a diff primitive's lines as a one-hunk patch, numbered as in the file
src/client/tour/state.ts                       NEW       the tour, the step shown, stale cards, per-snapshot file reads
src/client/tour/primitives/                    NEW       Card, Diff, Tree, Jump, Symbol, Callout, Diagram
src/client/styles/diagram.css                  NEW       a diagram's classes, from the theme tokens
src/client/tour/StepOutline.tsx                NEW       side panel (decision 14)
src/client/views/registry.ts, state.ts         MODIFIED  register 'tour'; ViewId gains 'tour'; ViewDef.useListed
src/client/views/ViewSwitch.tsx                MODIFIED  leaves out a view its useListed declines
src/client/keyboard/useKeymap.ts, HelpOverlay  MODIFIED  T toggles the tour view; help rows
test/e2e/tour.spec.ts                          NEW       pushes a tour over the fixture repository; screenshots
```

## Delivery

1. Protocol, store, validator, routes, `diffle tour push`/`clear`. Verify: `pixi run test-rust`, `pixi run test-node`.
2. The tour view: cards, groups, `diff`, `jump`, `tree`, `callout`, steps, `n`/`p`, outline, stale notice. Verify: `pixi run e2e -g tour`.
3. `diffle-symbol` through the language-server pool. Verify: `pixi run test-rust`, `pixi run e2e -g tour`.
4. `diffle --skill`. Verify: an insta snapshot of its output in `pixi run test-rust`.
5. The page redesign: drop `diffle-edge`, the page in place of the canvas (the canvas refactor reverted), wide cards, tables, `diffle-diagram`. Verify: `pixi run test-rust`, `pixi run e2e -g tour`.

Each slice ends with `pixi run lefthook-run` and `pixi run build-release`.

## Open questions

None.

## Follow-ups

- Comments on tour cards that reach the agent through diffle, for when reviewers want answers without leaving diffle (decision 7).
