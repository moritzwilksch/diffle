# Tours

A tour is a guided walkthrough of the reviewer's diff, written by their coding agent. Now that the CLI and the UI share one API surface (`diffle comments list` reaches the run through `<git-dir>/diffle/server.json`), the agent can read the diff, write one HTML document that explains it, and send it to the running diffle. Diffle renders it in a tour view, with diffle's styles applied. The agent composes the document from visual primitives diffle ships, such as a card holding a few lines of the diff with a short explanation and a button that jumps to those lines, or a file tree showing a directory layout. Scope: authoring format, primitives, delivery from the agent, storage, and the tour view. Out of scope until decided: editing a tour in the browser, several tours per review.

## Design decisions

### 1. Write a tour as an HTML article: headings for structure, blocks in the flow

- **Chosen:** The agent writes one HTML document, read as an article. An optional `h1` titles it, each `h2` starts a section, and `h3` a subsection. Between headings sit prose (`p`, `ul`, `ol`, `li`, `code`, `pre`, `strong`, `em`, `a`, `div`, `section`, `h4`, `details` with its `summary`) and blocks: `diffle-card`, `diffle-diff`, `diffle-walk`, `diffle-diagram`, `diffle-tree`, `diffle-callout`, and tables (`table`, `thead`, `tbody`, `tr`, `th`, `td`). Inline primitives (`diffle-symbol`, `diffle-jump`) sit in prose. Everything shares one centred column (decision 9).
- **Rejected:**
  - Markdown with primitive fences (` ```diffle-diff path=… `) through `src/client/Markdown.tsx`. It is safe already and agents write it reliably, but it carries no cards, diagrams or symbol chips.
  - A pannable, zoomable canvas of cards joined by arrows, as the graph view draws (`src/client/graph/GraphCanvas.tsx`). It was built first and dropped: the reviewer found it looked too much like the graph view and wanted a page, with cards wide enough that diff lines don't wrap. Arrows between cards also collided with group frames.
  - Cards and `diffle-group`s as the page's structure, a vertical stack of cards. Built second and dropped: the reviewer found the nested cards and the stack of boxes weird, and wanted the tour built like a web page, with headings as its structure.
- **Why:**
  - An article reads top to bottom like a walkthrough; headings give it structure without boxes inside boxes.
  - A diagram carries the pictures the canvas's arrows were for.

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
- **Why:** The block always shows the real, current diff, highlighted like the diff view, and its jump names the same lines.
- **Cost:** A card can go stale when a refresh moves or drops its lines (see decision 8).

### 5. The agent declares the structure and the rows; diffle sets the page

- **Chosen:** Headings make the structure (decision 1). A `diffle-card` stays as a block: a framed explainer for one part of the diff, with a title, a sentence or two and its `diffle-diff`s, beside prose, tables and diagrams; it holds no headings and no other card. A `diffle-row` puts two or three blocks or short prose columns side by side while the column has room (640px for two, 860px for three) and stacks them below that. Relations go in the prose or a `diffle-diagram`.
- **Rejected:**
  - `diffle-edge`, an arrow between two cards. A page can't draw arrows between cards cleanly.
  - Coordinates on each block. The agent can't know a block's rendered height, so blocks would overlap or leave gaps.
  - diffle forming rows itself from blocks that fit side by side. Only the agent knows which blocks belong together.
- **Why:** The agent states order, structure and what belongs together, which it knows; diffle handles the geometry.

### 6. A tour is an ordered walk: its `h2` sections are the steps

- **Chosen:** Each `h2` is a step, in document order; the heading shows its number in a soft circle above a hairline. `n` and `p`, and a click in the table of contents, move to a section and scroll its heading to the top of the page, below the gap the diff keeps above a file header it lands (`layout.gap` in `src/client/review/geometry.ts`, 1rem): the reviewer's call, so a section lands as a file does. A section near the end that cannot reach the top scrolls the page as far as it goes and stays the current one; the article ends with its normal padding, no extra room. Scrolling the page makes the section whose heading passed that line the current one, and the last section at the very bottom. A taken section stays current through its glide and landing, until the reader scrolls (wheel, touch, `j`/`k`, `d`/`u`), so `n` pressed twice reaches the second section. `j`/`k` and `d`/`u` scroll the page.
- **Rejected:**
  - No order at all. The reviewer would have to guess where to begin.
  - A `step` attribute on cards. A page reads top to bottom, so document order is the walk.
- **Why:** A tour exists to give the reviewer a high-level walk through the change. The order the agent picks is part of the explanation.

### 7. The reviewer comments on the tour in diffle

- **Chosen:** Superseded by `plans/tour-comments.md`: a tour thread is a comment thread on a passage or an element of the tour, shown in a margin beside the article, read through `diffle comments list` and the prompt, and answered with `diffle comments reply`. The reviewer can still answer in the agent's own chat.
- **Rejected:** Feedback only in the agent's chat (this decision's first version). It needed no anchor, but a question about one paragraph left diffle, and the agent had to guess which passage it was about.
- **Why:** Reviewers wanted to ask about a card or a sentence where they read it.

### 8. A tour survives refreshes; a diff whose lines left the review says so in place

- **Chosen:** The tour stays under its `commentKey` across `Snapshot.version` changes. Each `diffle-diff` resolves against the current snapshot when it renders: the client cuts its lines from the file's patch and its text on that side (`src/client/tour/excerpt.ts`). When its lines are gone (the file left that side, or the range runs past its end), the diff shows a stale notice in place of the lines, and its jump still goes to the file. The view's header counts the stale diffs, and the table of contents marks each section holding one.
- **Rejected:** Dropping the tour, or marking all of it stale, once the snapshot moves past the version it was pushed against. Simpler, and it never shows outdated prose, but one fixup commit would wipe out a tour the reviewer was halfway through.
- **Why:** The agent keeps editing code while the tour is open, and most diffs keep their lines. The stale count tells the reviewer when to ask for a fresh push.

### 9. Eighteen primitives, all structure and no styling knobs

- **Chosen:**

  | Element          | Attributes                                                              | Shows                                                                                                                  |
  | ---------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
  | `diffle-card`    | `id`, `title`, `icon?`                                                  | a framed explainer for one part of the diff: its title, prose and `diffle-diff`s                                       |
  | `diffle-code`    | `lang?`, `path?`, `line?`, `example?`, `title?`; holds its code as text | a signature or interface the agent writes, or a made-up example, highlighted in the diff's frame                       |
  | `diffle-row`     | none; holds two or three columns                                        | blocks or short prose side by side, stacked in a narrow column                                                         |
  | `diffle-diff`    | `path`, `side?` (`old` \| `new`, default `new`), `lines` (`40-58`)      | those diff lines, highlighted, with a jump to them                                                                     |
  | `diffle-walk`    | `path`, `side?`, `lines`; holds `diffle-note`s                          | those diff lines walked one note at a time (decision 21)                                                               |
  | `diffle-note`    | `lines?`, `title`; holds a sentence of inline prose                     | one step of a walk (its lines lit) or a stepped diagram (decision 22), its text under it                               |
  | `diffle-trace`   | none; holds `diffle-stop`s                                              | a call followed through several places, one stop at a time (decision 23)                                               |
  | `diffle-stop`    | `path`, `line`, `side?`; holds a sentence of inline prose               | one stop of a trace: its line lit among a few around it                                                                |
  | `diffle-tabs`    | none; holds two to four `diffle-tab`s                                   | alternatives in one block's width, one shown at a time (decision 24)                                                   |
  | `diffle-tab`     | `title`, `kind?` (`chosen` \| `rejected` \| `example`)                  | one pane of tabs, holding what a card holds                                                                            |
  | `diffle-check`   | none; holds `diffle-item`s                                              | questions the reviewer ticks or answers (decision 26)                                                                  |
  | `diffle-item`    | `context?`; holds a line of inline prose                                | one question of a checklist                                                                                            |
  | `diffle-tree`    | `paths` (newline-separated), `root?`                                    | a directory tree; changed files carry their status from the snapshot                                                   |
  | `diffle-jump`    | `path`, `line?`, `side?`                                                | a button into the diff view                                                                                            |
  | `diffle-symbol`  | `path`, `line`, `name`, `side?`                                         | the symbol `name`, coloured as the diff colours it on that line; it hovers and lists references like the diff's tokens |
  | `diffle-callout` | `kind` (`info` \| `warning` \| `danger`)                                | a highlighted aside                                                                                                    |
  | `diffle-diagram` | none; holds one `<svg viewBox>`                                         | a simple architecture diagram the agent draws by hand, styled by diffle                                                |
  | `diffle-icon`    | `name`, `tone?` (`accent` \| `success` \| `warning` \| `error`)         | a Lucide icon in a line of text, at its size and colour (decision 20)                                                  |

- **Rejected:** Styling attributes (colours, sizes, widths). Theme tokens and the layout cover them, and every knob is one more thing the agent can get wrong.
- **Why:** These answer "what changed, where, and how it connects", and a small catalog is one an agent learns reliably. Prose, callouts and blocks share one centred 920px column, as on a well-set page: wider than a prose measure, wide enough that a 100-character line in a card's diff doesn't wrap. A diagram shows at its own width up to the column's, never larger.
- **Diagrams:** `TourSvgElementSchema` allows `svg` (`viewBox="0 0 <w> <h>"`), `g`, `rect`, `circle`, `ellipse`, `polygon`, `path`, `line`, `polyline`, `text` and `tspan`, each with its geometry and a `class`. `TourSvgClassSchema` is the vocabulary, a subset of the svg-diagram skill's: `arrow`, `arrows`, `dashed`; `bold`, `small`, `mono`, `c`, `e`, `eyebrow`; `fill`, `frame`; `accent`, `success`, `warning`, `error`. `src/client/styles/diagram.css` styles them from the theme tokens, and `src/client/tour/primitives/Diagram.tsx` redraws only what the catalog allows and adds arrowheads in each line's tone. A table compares or maps; a diagram shows how parts connect. A diagram's `text class="code" lang="…"` holds code lines, one `tspan` each, coloured by the diff's highlighter (`primitives/DiagramCode.tsx`). An `<svg data-lucide x y size?>` nested in the drawing is a Lucide icon (`TourSvgIconSchema`, decision 20).
- **Constraint:** `diffle-symbol` takes its colour from `highlightLines` (`src/client/lsp/highlight.tsx`), the shared highlighter and theme that lists outside the diff use, over its line alone, so it needs no language server and works on the old side. Hover and references depend on the language servers. When `lspBlocker` (`src/shared/lsp.ts`) returns a reason, the chip stays coloured code without hover, and its tooltip gives that reason. Servers answer for the new side only, so a symbol on the old side never hovers. Hovering goes through the diff's own `hoverControl` and `HoverTooltip` (`src/client/lsp/HoverTooltip.tsx`) and the store's `requestHover`. A click finds the name on its line as a whole word, asks `POST /api/lsp/references`, and opens the references list the diff's `gA` opens. `diffle --skill` tells agents to mark every symbol their prose names this way and keep `<code>` for paths, commands and literals.

### 10. The server validates a pushed tour; a bad one fails the CLI with exit 2

- **Chosen:** `PUT /api/tour` parses the document in Rust with `html5ever` (MIT OR Apache-2.0, both in `about.toml`'s `accepted`), through a small arena tree sink of its own (`tour/dom.rs`; `markup5ever_rcdom` is test-only by its authors' word), so the validator sees the tree `DOMParser` builds. It refuses:
  - unknown elements and attributes, and any attribute on a plain tag but an `http(s)` `href` on `a` and a positive `colspan` or `rowspan` on `th` and `td`
  - an element where it may not sit (`tour/placement.rs`): `h1`, `h2` and `h3` off the top level, a block inside a line of text, a card in a card or callout, a callout in a callout, a row off the top level, an inline primitive at the top level, bare text at the top level
  - a second `h1`, an `h1` after an `h2`, a document without an `h2`, a card without a `diffle-diff`
  - a `diffle-row` without two or three columns, or with a column that is neither a block nor a `div`, `p`, `ul` or `ol`
  - content in an element that holds none (`diffle-diff`, `diffle-tree`, `diffle-symbol`), which is what `<diffle-diff ... />` produces, since HTML ignores `/>` there
  - in a `diffle-diagram` (`tour/diagram.rs`): anything but one `<svg>`; an element or class outside the diagram catalog; `style`, `fill`, `stroke`, font, marker and other styling attributes; `<defs>` and markers (diffle draws the arrowheads); a `tspan` outside a `text`; an `<svg>` outside a diagram
  - a duplicate card `id`
  - a `path` outside the snapshot on the side it names, or a tree path outside its `root`
  - a line range past the end of its file on that side
  - a `diffle-symbol` whose `name` isn't on its line as a whole word

  Each error names the element and the reason. A refusal is a user error (`Error::is_user_error`), so `diffle tour push` exits 2 with the list, and the agent fixes the document and pushes again. The client still applies its own allowlist when rendering (decision 2).

  An accepted push can carry warnings in the same `{element, message}` shape, which `diffle tour push` prints to stderr while it exits 0. They are judgment calls from a diagram's geometry (`tour/layout.rs`), against the layout rules `--skill` gives: a label that may be wider than its box or run past it (the per-character estimate, so the message says "may"), a lone label off its box's vertical middle, a rect off the 8-unit grid or past the drawing's edge, a drawing wider than the column it sits in, more than about a third of the shapes toned. A diff in a row also warns that its lines may wrap, with the column's width. A `diffle-code` (`tour/code.rs`) warns when its first declaration is not within two lines of its `line`, when most of its lines are among the review's changed lines (from `Snapshotter::patch_all`), and past 12 lines; a code line in a diagram warns like a label wider than its box. Refusing these was rejected: the estimate can be wrong, and the agent can judge.

- **Rejected:** Storing any document and letting the client drop what it doesn't know. The agent would never learn that a card or a diagram vanished, and the reviewer would get a broken tour.
- **Why:** The agent writes and pushes in a loop, so the CLI's exit status and stderr are its only feedback.
- **Cost:** A new dependency, plus an allowlist on each side of the contract; decision 11 gives both one source.

### 11. `protocol.ts` defines the catalog; the client, the validator and the agent's documentation all read it

- **Chosen:** In `src/shared/protocol.ts`, each `diffle-*` element is a `.strict()` zod object of its attributes, documented with JSDoc. `TourElementSchema` is their discriminated union on `tag`, and `TourTagSchema` is a `z.enum` of the plain tags. They cross to Rust like the rest of the contract (`protocol.generated.json`, `build.rs`). The validator (decision 10) turns each parsed element into `{tag, ...attributes}` and deserializes it into `crate::protocol::TourElement`, so an unknown tag or attribute fails there. `TourSvgElementSchema` and `TourSvgClassSchema` do the same for a diagram's `<svg>`. Cross-element rules (one title, at least one section, unique card ids, paths, symbol names) stay in Rust. The client builds its allowlist (decision 2) from the same schemas. The agent documentation (decision 13) prints the catalog from the schemas' descriptions, with one example document and the authoring rules: one `h2` per step of the walk, cards for one part of the diff each, rows for blocks that belong together.
- **Rejected:**
  - A Rust table in `crates/diffle/src/tour/catalog.rs` plus a Node test comparing it with a TypeScript copy. Two hand-kept copies, and a test whose only job is to catch drift between them.
  - A separate, hand-written skill file or `AGENTS.md` snippet. It would drift from the running diffle and needs an install step.
- **Why:**
  - `protocol.ts` is already the only client/server contract, so this adds no new mechanism.
  - What the agent reads can't disagree with what the validator enforces.
- **Constraint:** HTML attribute values are strings, so the attribute schemas use strings: `z.enum` for `side` and `kind`, and a regex for `id` and `lines`. A `.strict()` object exports `additionalProperties: false`, which typify 0.8 turns into `#[serde(deny_unknown_fields)]` (verified in `typify-impl-0.8.0/src/structs.rs`; `crates/diffle/Cargo.toml` pins `typify = "0.8"`).

### 12. The tour is a third `ViewDef`, a page of its own; the graph view is untouched

- **Chosen:** `src/client/tour/TourPage.tsx` renders the page. Register `tourView` in `src/client/views/registry.ts` with `id: 'tour'`. Its `blocked` returns a reason while the review has no tour, and the header's view switch lists it only while there is one (`ViewDef.useListed`), so reviews without tours look as before. Its `keys` take `n` and `p` for sections, `j`/`k`/`d`/`u` to scroll (decision 6), and `l`/`h` for a walk's notes (decision 21). `T` toggles it (`toggleView('tour')` in `src/client/keyboard/useKeymap.ts`, next to `M` for the graph); in the graph view `T` stays the tests filter.
- **Rejected:** Sharing the graph's canvas (`src/client/canvas/`, the viewport and a generalized layered layout). It was built for the canvas tour and reverted with it (decision 1); the graph's code is as on `main`.
- **Why:** A page needs no viewport or layout, so the graph view has nothing to share.

### 13. `diffle --skill` prints the agent interface as Markdown, with no frontmatter

- **Chosen:** A top-level `--skill` flag, declared `exclusive = true` in `crates/diffle/src/cli/args.rs` so clap refuses it alongside a revision or any review option; `exclusive` does not cover subcommands, so `cli/mod.rs` refuses `--skill` with one as a usage error. It prints the whole agent interface to stdout: how to reach the run, `diffle comments`, `diffle tour push` and `clear`, and the catalog (decision 11). The output has no frontmatter. The user wraps it in their own and installs it under the name and description they choose.
- **Rejected:**
  - A `diffle skill` subcommand. It sits next to `comments`, `config` and `lsp`, but the user prefers the flag. `exclusive` removes the one concern: `diffle main --skill` would otherwise parse.
  - Output with `name`/`description` frontmatter. It would fix a skill name and description that users want to pick themselves.
- **Why:** One command an agent can run to learn everything diffle offers it, always matching the binary that answers.

### 14. The tour view's side panel is the table of contents

- **Chosen:** `ViewDef.Side` (`src/client/tour/Contents.tsx`) lists the `h1` as its heading, each `h2` with its number and its `h3`s under it, marks the current section and those holding a stale diff (decision 8). Clicking a heading scrolls to it.
- **Rejected:** Details of a selected block, like the graph view's `GraphDetails`. They would repeat what the page already shows.
- **Why:** The walk is the main way to read a tour (decision 6). The contents show where the reviewer is in it and how much remains.

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

### 18. The agent writes the interfaces it shows; diffle never fills them from a language server

- **Chosen:** `diffle-code` holds code the agent writes, for signatures, interfaces, type definitions and the shape of an abstraction: what a collaborator offers and takes, bodies elided, private details left out. diffle shows it as the diff's rows, an unchanged hunk through `DiffRows` (`primitives/Diff.tsx`): the same frame, gutter and highlighter, numbered from `line` (else 1), full width, long lines wrapped, and warns when it repeats the diff, runs long, or misses its line (decision 10). Changed code stays in `diffle-diff`.
- **Rejected:** Signatures filled from the language servers (hover or document symbols for a path and line). The reviewer's call: every tour feature must work without a language server, and the agent already knows which parts of an interface matter.
- **Why:** A walk through collaborators needs more than a diagram's names and less than the whole diff; the agent can write exactly that.
- **Examples:** `example` (an HTML boolean attribute) marks a `diffle-code` the agent made up: data as it flows (a request, a response, a token, a config, the order of calls), a simplified spike, or an alternative design. The header labels it "Example", beside its `title`, so it never passes for the repository's code; it takes `lang` and refuses `path` and `line`. The reviewer's call: an example shows how information flows, and is never a way to rehash the diff, so changed code stays in `diffle-diff`. Warnings: "Repeats the diff" when most lines are changed lines verbatim, "May re-type the diff" when half or more match but for spacing and trailing `,` or `;` (every `diffle-code`), and past 20 lines for an example instead of the 12 of a signature block. Rejected: a separate `diffle-example` element; it would duplicate the highlighting, the frame and the diff check for one flag's worth of difference.

### 19. Ship in slices, the server first

- **Chosen:** The order under **Delivery**.
- **Rejected:** The UI first. Without the validator, nothing tells the agent what it got wrong.
- **Why:** An agent can push and get refusals before any UI exists, which tests the catalog and the validator early.

### 20. Lucide icons by name, in text and in diagrams, each loaded on first use

- **Chosen:** `<diffle-icon name tone?>` sits in a line of text at its size and colour; a card takes `icon` before its title; a diagram takes `<svg data-lucide x y size?>`, 14 square by default, in its text's colour or its group's tone. The names are those `lucide-react` ships: `test/scripts/lucide-icons.test.ts` writes its `dynamicIconImports` keys to `crates/diffle/lucide-icons.generated.txt`, which the validator embeds (`tour/icon.rs`) to refuse an unknown name with the three closest (most shared words, then edit distance, `strsim`). The client loads the name map and then each icon from chunks of their own (`primitives/Icon.tsx`). `--skill` tells the agent to use an icon to mark one kind of thing consistently, never as decoration, and where it sits in a node; the layout warnings (`tour/layout.rs`) check an icon sits inside its box, on its middle and clear of its text, and that labelled boxes of one height carry an icon all or none.
- **Rejected:** The names as a `z.enum` in the contract. typify would generate a 2,171-variant enum, and serde's refusal would list every name instead of the closest few. Rejected too: importing the map into the main bundle, which added 274 kB (57 kB gzipped) to it.
- **Why:** An icon marks a kind of thing at a glance, as in the svg-diagram convention. Every name the validator accepts is one the client can load, and the client ships only the icons a tour names.
- **Cost:** About 2,170 chunks of a few hundred bytes each in the client build (522 files grew to 2,336; 18.3 MB to 19.3 MB on disk).

### 21. A walk explains one piece of code step by step, its note inline under the lit lines

- **Chosen:** `<diffle-walk path side? lines>` holds ordered `<diffle-note lines title>` elements, each a title and a sentence of inline prose. It renders as a `diffle-diff` does (same excerpt, rows, stale notice and Open; `primitives/Walk.tsx` reuses `useExcerpt` and `DiffRows`), full width, one column. Its header carries a stepper: ‹, the note numbers, ›, always present at fixed places, so a click lands where it did on the step before; the active note's title is never in the header. At rest the diff shows plainly with each note's number on the gutter of its first line. Taking a note (its number in the header or on the gutter, or `l` / `h` and the arrow keys) lights its rows, dims the others, and hangs a compact full-width band under its last lit row: number, title, sentence. `h` from the first note returns to rest. Stepping scrolls the page only as far as the lit rows and the band need. The keys step exactly one block: the topmost wholly in view, else the one covering the most of the view (a block taller than it); its stepper is tinted in the accent, so the reader can predict a keypress. Every stepped block (walk, trace, stepped diagram) shares the stepper, the band, the keys and the scroll (`src/client/tour/steps/`), and the server checks their steps alike (`crates/diffle/src/tour/stepped/`). The band is a `@pierre/diffs` line annotation, so it sits inside the diff without a second renderer; the marks and the dimming are `unsafeCSS` in the diff's shadow root, built from the excerpt's rows (`tour/walk.ts`).
- **Validator (`tour/walk.rs`):** refuses a walk without notes, anything but notes in a walk, a note outside one, a note without `title`, a note whose lines leave the walk's, and block or paragraph content in a note. Warns past about 6 notes, past about 40 lines, a note of more than about two sentences ("may"), and notes that share lines.
- **Comments:** a walk takes a thread as a whole like a diff (label `path lines`); a note's words take a text selection, its reading text its title then its sentence. A thread on a note the walk is not showing places its card at the walk, and focusing it takes that note.
- **Rejected:**
  - Callouts beside the lines, as comments hang in the diff. The reviewer expected them to look busy, worst in a narrow window.
  - A numbered list of the notes in a side column, as in the presentation template the reviewer showed. It costs width on a laptop or beside other windows, and the reviewer asked for a walk that does not.
- **Why:** A loop, a handler or a pipeline reads best in order; lighting one part at a time keeps the reader's eye on it, and the band keeps the explanation next to the lines at any width.

### 22. A diagram steps through its groups with the walk's stepper and band

- **Chosen:** A `<g>` in a `diffle-diagram`'s drawing takes `step="n"`, and the diagram holds one `diffle-note` (a title and a sentence, no `lines`) per step after its `<svg>`. A stepped diagram renders in a frame with the shared stepper in its header (`steps/StepDiagram.tsx`); a taken step lights its groups (edge, face, lines and arrowheads in the accent, through the drawing's `--edge`, `--face` and `--line`) and dims the other steps' groups, and its note shows under the drawing in the walk's band. The validator (`tour/stepped/diagram.rs`) refuses steps with a gap, a note count other than the step count, notes without stepped groups, and `lines` on a diagram's note; it warns as for a walk. A diagram without notes renders as before.
- **Rejected:** A `step` attribute on the note instead of its order. Order already numbers the steps, as a walk's notes do, and one fewer attribute is one fewer mismatch.
- **Why:** A request's trip or a pipeline's stages read in order; lighting one stage keeps the eye on it without a second diagram per stage.

### 23. A trace follows a call through several files, one stop at a time

- **Chosen:** `<diffle-trace>` holds `<diffle-stop path line side?>`s in call order, each a sentence of inline prose. It starts on its first stop and shows that stop's line lit among 3 lines on each side, cut from the file as the snapshot has it (`rangePatch` with context, clamped to the file), with the sentence in the walk's band under the line. Its header holds a tab per stop (number and file name, the full place in its tip) and the shared stepper, pinned at the right; a second row names the stop's path and line with Open. A stop whose line left the review says so in place, and counts as a stale diff. The validator checks each stop's file and line as a `diffle-diff`'s, refuses anything but stops, warns of more than about 6 stops and of a trace of one stop (a diff shows one place).
- **Rejected:** All stops shown at once, one excerpt each. That is a column of diffs, which prose and `diffle-diff` already make.
- **Why:** A request's path through a handler, a helper and a store reads in call order; one stop at a time keeps the reader on the line that matters at each.

### 24. Tabs set two to four alternatives in one block's width

- **Chosen:** `<diffle-tabs>` holds two to four `<diffle-tab title kind?>` panes, one shown at a time; `kind` (`chosen`, `rejected`, `example`) shows as a chip beside the title, the chosen one in the add tone. A pane holds what a card holds. The validator (`tour/tabs.rs`) refuses fewer than two or more than four tabs, content other than tabs, a tab without `title`, a tab outside tabs, and tabs inside a tab. The tabs take a thread as a whole (label: their titles), a pane's words a selection; a focused thread on a hidden pane shows that pane.
- **Rejected:** A `diffle-row` of the alternatives. It halves each one's width, and a diff in it wraps.
- **Why:** A design next to the one it beat, or a payload before and after, reads best in one place, at full width.

### 25. `<details>` folds away what the main path can do without

- **Chosen:** `details` and `summary` are plain tags. A `<details>` is a block that opens with one `<summary>` (a line of text) and holds what a card holds; the validator refuses one without a summary first, a summary elsewhere, and a `<details>` in a line of text. Its frame, the turning chevron and the open border come from `tour.css`. `--skill` limits it to what the main path can do without: an edge case, a long aside.
- **Rejected:** A `diffle-aside` element. The platform's own element opens and closes without script and is one an agent already writes.
- **Why:** Some explanations matter to one reviewer in five; folded, they cost the others one line.

### 26. A checklist asks the reviewer to decide; its ticks and answers reach the agent

- **Chosen:** `<diffle-check>` holds `<diffle-item context?>` questions, one line of inline prose each. The reviewer ticks an item as decided or answers it. An answer is a tour thread on the item as a whole (its label the question, whitespace collapsed), so replies, the agent's `diffle comments reply`, `diffle comments list` and relocation on a push come with it. A tick is a question kept in the stored tour's `ticked` (`tours.json`, under the comment key); a push keeps the ticks whose question it still asks, in the same write that replaces the tour. `TourIndex::checks` names each item's question, so the reading rule has one owner; `GET /api/tour` answers the items with their ticks, `PUT /api/tour/ticks` sets one, and `ThreadList.checks` gives each with its tick and answering thread. The prompt carries, after the threads, every item not settled by a tick alone: `(check) 4. Heading, open` or `decided`, the question, and its answer or `(no answer yet)`; a ticked item without an answer drops out. The validator refuses an item without a question, two items asking the same, an item outside a checklist, and anything but items in one; it warns as for a stepped block.
- **Rejected:**
  - A separate `checks.json`, the first proposal. A tick only means something with its tour, and keeping it there carries ticks across a push in one locked write.
  - Ticks as resolved threads. A tick without an answer has no message for a thread to hold.
- **Why:** The reviewer asked for a checklist only if what they tick and answer reaches the agent; the prompt and `diffle comments list` are the two places it reads.

## Context for the implementer

- The agent runs in the reviewer's worktree, next to a running diffle. It reaches the server the way `diffle comments` does (`crates/diffle/src/cli/agent/server.rs`, `reach`).
- The reviewer opens the tour, reads it top to bottom, and jumps from a card into the diff view, which keeps its own scroll (`src/client/views/state.ts`: views stay mounted).
- Tour HTML is written by an agent that read repository content, so it is untrusted, like a comment body (`src/client/Markdown.tsx` drops raw HTML and images for that reason).

## Interfaces and files

CLI:

```
diffle tour push [<file>|-] [-C <path>]   # PUT /api/tour; prints Tour as JSON, warnings on stderr; exit 2 with the errors on 422
diffle tour clear [-C <path>]             # DELETE /api/tour
diffle --skill                            # prints the agent interface as Markdown; exclusive
```

```
src/shared/protocol.ts                         MODIFIED  Tour, TourPush, TourResponse, TourPushed, TourRejection, TourElement (+ one strict attribute schema per diffle-* element), TourTag, TourSvgElement, TourSvgClass, ServerMessage 'tour'
crates/diffle/protocol.generated.json          MODIFIED  regenerated (npx vitest run test/scripts/protocol-schema.test.ts -u)
crates/diffle/Cargo.toml                       MODIFIED  html5ever
crates/diffle/src/tour/mod.rs                  NEW       module root
crates/diffle/src/tour/store.rs                NEW       <git-dir>/diffle/tours.json, one tour per commentKey
crates/diffle/src/tour/dom.rs                  NEW       html5ever into an arena tree, as DOMParser builds it
crates/diffle/src/tour/validate.rs             NEW       check against TourElement and TourTag, rows, cross-element rules (decision 10)
crates/diffle/src/tour/placement.rs            NEW       where each element may sit in the article
crates/diffle/src/tour/layout.rs               NEW       warnings from a diagram's geometry; the column's widths
crates/diffle/src/tour/drawing.rs              NEW       a diagram's boxes, labels and icons, as the warnings read them
crates/diffle/src/tour/icon.rs                 NEW       the Lucide names a tour may use, and the closest to a wrong one
crates/diffle/lucide-icons.generated.txt       NEW       lucide-react's icon names (test/scripts/lucide-icons.test.ts -u)
crates/diffle/src/tour/code.rs                 NEW       a diffle-code block's lines and its warnings
crates/diffle/src/tour/stepped/                NEW       steps of stepped blocks (mod.rs), a walk's lines (walk.rs)
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
src/client/tour/TourPage.tsx                   NEW       the article: one column, a section's heading scrolled near the top
src/client/tour/document.ts                    NEW       DOMParser → title, h2 sections with their h3s and diffs
src/client/tour/render.tsx                     NEW       the article → allowlisted React (decision 2)
src/client/tour/excerpt.ts                     NEW       a diff primitive's lines as a one-hunk patch, numbered as in the file
src/client/tour/state.ts                       NEW       the tour, the section read, stale sections, per-snapshot file reads
src/client/tour/primitives/                    NEW       Card, Code, Diff, Tree, Jump, Symbol, Callout, Diagram, DiagramCode, Icon
src/client/tour/steps/                         NEW       the shared stepper, band, keys and scroll (steps.ts, Stepper.tsx); a walk (Walk.tsx) and its lit rows (rows.ts)
src/client/styles/diagram.css                  NEW       a diagram's classes, from the theme tokens
src/client/styles/tour.css                     NEW       the article: column, headings, rhythm, cards, rows
src/client/tour/Contents.tsx                   NEW       side panel (decision 14)
src/client/views/registry.ts, state.ts         MODIFIED  register 'tour'; ViewId gains 'tour'; ViewDef.useListed
src/client/views/ViewSwitch.tsx                MODIFIED  leaves out a view its useListed declines
src/client/keyboard/useKeymap.ts, HelpOverlay  MODIFIED  T toggles the tour view; help rows
test/e2e/tour.spec.ts                          NEW       pushes a tour over the fixture repository; screenshots
```

## Delivery

1. Protocol, store, validator, routes, `diffle tour push`/`clear`. Verify: `pixi run test-rust`, `pixi run test-node`.
2. The tour view: `diff`, `jump`, `tree`, `callout`, `n`/`p`, side panel, stale notice. Verify: `pixi run e2e -g tour`.
3. `diffle-symbol` through the language-server pool. Verify: `pixi run test-rust`, `pixi run e2e -g tour`.
4. `diffle --skill`. Verify: an insta snapshot of its output in `pixi run test-rust`.
5. The page redesign: drop `diffle-edge`, the page in place of the canvas (the canvas refactor reverted), wide cards, tables, `diffle-diagram`. Verify: `pixi run test-rust`, `pixi run e2e -g tour`.
6. Warnings on an accepted push. Verify: `pixi run test-rust`.
7. The article: headings as structure, cards as blocks, `diffle-row`, one centred column. Verify: `pixi run test-rust`, `pixi run e2e -g tour`.
8. `diffle-code` and code in diagrams, with their warnings. Verify: `pixi run test-rust`, `pixi run e2e -g tour`.
9. Lucide icons in text, card titles and diagrams, with their name check and layout warnings. Verify: `pixi run test-rust`, `pixi run test-node`, `pixi run e2e -g tour`.
10. Examples: `diffle-code example`, its label, refusals and warnings. Verify: `pixi run test-rust`, `pixi run e2e -g tour`.
11. Walks: `diffle-walk` and `diffle-note`, the stepper, keys, refusals and warnings. Verify: `pixi run test-rust`, `pixi run test-node`, `pixi run e2e -g 'the tour'`.
12. Stepped diagrams: `step` on a diagram's groups, its notes. Verify: `pixi run test-rust`, `pixi run test-node`, `pixi run e2e -g 'the tour'`.
13. Traces: `diffle-trace` and `diffle-stop`. Verify: as slice 12.
14. Tabs: `diffle-tabs` and `diffle-tab`. Verify: as slice 12.
15. Details: `<details>` and `<summary>`. Verify: as slice 12.
16. Checklists: `diffle-check`, `diffle-item`, ticks, answers, the prompt and the list. Verify: as slice 12.

Each slice ends with `pixi run lefthook-run` and `pixi run build-release`.

## Open questions

None.

## Follow-ups

None.
