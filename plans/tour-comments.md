# Tour comments

The reviewer comments on the tour as they comment on code: select a phrase or pick a diagram box or a block, write, and the thread shows in the margin beside the article. A tour thread is a comment thread: same store (keyed by `Snapshot.commentKey`), same messages, replies, resolve and agent marks, the same `CommentCard` and `CommentComposer`, the same `diffle comments list` and prompt copy. The agent reads every thread and answers any of them with `diffle comments reply` (decision 6). This replaces decision 7 of `plans/tours.md` ("a tour is not a comment anchor"). Scope: the anchor, relocation across pushes, the prompt and list, the margin, and the agent's reply.

## Design decisions

### 1. A `tour` anchor names an element by its place in the document, and the text in it

- **Chosen:** A third `CommentAnchor` kind:

  ```ts
  TourAnchorSchema = z.object({
    kind: z.literal('tour'),
    /** Child-element indices from <body> to the element, in the tour as last pushed. */
    node: z.number().int().array(),
    /** The h2 it sits under: its 1-based number and heading text; absent before the first. */
    step: z.number().int().optional(),
    section: z.string(),
    /** The element as a refused push names it, after its diagram or card: `diffle-card#auth > <p>`. */
    element: z.string(),
    target: TourTargetSchema,
  });
  TourTargetSchema = z.discriminatedUnion('on', [
    /** A selection: its words, whitespace collapsed, and which match in the element's reading text. */
    z.object({
      on: z.literal('text'),
      quoted: z.string(),
      occurrence: z.number().int(),
    }),
    /** The element as a whole, with what finds it again: a card's title, a box's text; '' for none. */
    z.object({ on: z.literal('element'), label: z.string() }),
  ]);
  ```

  The browser sends `node` and a `TourTargetRequest` (the text target, or `{on: 'element'}`); the server fills `step`, `section`, `element`, and an element's label from the stored tour, as it quotes a code range from the snapshot. Both target unions are named schemas, so typify generates tagged enums.

  What can carry a thread: a selection within one top-level block of prose (paragraphs, list items, headings, table cells, callout and card prose); a whole block (`diffle-card`, `diffle-diff`, `diffle-code`, `diffle-tree`, `diffle-callout`, `diffle-diagram`, `table`); a diagram box (a `rect` with its labels, by `Drawing::box_of`) or a lone `text`.

  An element's **reading text** is what the reader sees, defined once on each side: text nodes, a `diffle-symbol`'s `name`, a `diffle-jump`'s text or `path[:line]`, a card's `title` before its content; `diffle-diff`, `diffle-code`, `diffle-tree` and `diffle-diagram` add nothing (they take element anchors). Matching ignores whitespace on both sides: a selection's line breaks and the source's indentation never agree.

- **Rejected:**
  - Character offsets into the source HTML. Inline primitives render text the source doesn't hold (a symbol's name), so rendered selections and source offsets don't line up.
  - A heading-only anchor (comment on a section). Too coarse for the screenshot's cases: a phrase and a diagram box.
  - Reusing `path` as the field name. Code reads `anchor.path` as a file path everywhere (Markdown, the panel, `activePath`); `node` makes the compiler find each place that must handle tours.
- **Why:** `node` finds the element exactly in the tour it was made on; `quoted`, `section` and `element` find it again in a revised tour (decision 2) and tell the agent what it is about (decision 3).
- **Cost:** The reading-text rule exists twice, `tour/anchor.rs` and `src/client/tour/anchor.ts`. The e2e scenario comments on prose holding a symbol and a jump, and a Rust test relocates the same document.

### 2. A push relocates tour threads on the server; a clear makes them stale

- **Chosen:** `PUT /api/tour`, after accepting, re-anchors the set's tour threads against the new document, as a snapshot refresh re-anchors line threads:
  - text: an element of the same tag whose reading text contains `quoted`; prefer the same section heading, then the nearest `node`, then the occurrence nearest the old one.
  - element: an element of the same kind with the same non-empty label (a box with the same text, a card with the same title, a diff of the same `path` and `lines`); same preferences. An element without a label (a table, a diagram) matches by kind and `node` within its section.
  - Not found: `stale`, the anchor kept as it was. A later push that brings the text back revives it.

  `DELETE /api/tour` marks every tour thread stale. Snapshot refreshes leave tour anchors alone. Changes go through `Session::record`, so `/ws` and `/api/threads/activity` announce them.

- **Rejected:**
  - Stale in place on every push. The loop is "reviewer comments, agent revises, pushes": every revision would stale every thread, including the ones about untouched passages.
  - Showing threads "on an earlier tour". Only the latest tour is stored (`tours.json`, one per key), so there is nothing to show them on.
  - Relocating in the browser. Staleness would be invisible to `diffle comments list` and the prompt, and two open tabs would race.
- **Why:** A thread stays put while its passage survives a revision. One the agent rewrote in answer goes stale with its quote, which tells the reviewer it was addressed; they resolve it.

### 3. The prompt names the section and the element; `list` carries the anchor as is

- **Chosen:** `format_prompt` writes a tour thread as:

  ```
  (tour) 2. Session and refresh, in a <p>

  > comment on the tour

  body

  ---
  (tour, stale) 2. Session and refresh, on a box in the diagram

  > Session

  ---
  ```

  `in` for a selection inside the element, `on` for the element itself. The prompt names the element by its kind and the one handle the agent can search its document for (`the card #entry`, `the diff of src/app.py:12-20`, `a box in the diagram`, `a <p> in the card #entry`), never its geometry or the text the quote already shows; the anchor's `element` keeps the full name a refused push would give. The section reads `before the first section` when `step` is absent; the quote is the selection or the label, left out when empty. Tour threads follow the code threads, in document order (`node`). `diffle comments list` prints the anchor's JSON unchanged; `--path` matches code threads only. GitHub export skips tour threads ("a comment on the tour has no place in a pull request review"), and `CommentCard` hides its export button for them. `--skill` describes the anchor under "Read the review's comments" and tells the agent to find the passage by `section`, `element` and `quoted`.

- **Rejected:** Printing `node` in the prompt. The agent keeps its document as written, not as indices; heading, element and quote find the place with a search.
- **Why:** The agent reads the prompt next to the document it wrote; the validator's element names are the ones its push errors already use.

### 4. Threads hang in a margin rail beside the column; a narrow page puts them inline

- **Chosen:**
  - **Placement:** `TourPage` lays out the column and an 18rem rail to its right, 1.5rem apart, the pair centred. The rail is reserved whenever it fits, threads or not, so the article doesn't move when the first comment lands. Each card's wanted top is its anchor's top (the selection's first line, the block's or box's top).
  - **Collisions:** cards keep document order; each takes `max(wanted, previous bottom + 0.5rem)`. The active card (the draft, an open reply, the focused thread) sits exactly at its anchor and pushes the cards above it up. A `ResizeObserver` on the article and the cards re-places them as diffs load and threads grow.
  - **Narrow windows:** the column narrows from 920px to 680px before the rail goes (cards' diffs may wrap there, as in a row). Below `680 + rail`, threads render inline, full width, after the top-level block holding their anchor, as the diff hangs a card under its line.
  - **Contents panel:** unchanged in place; it shows each section's open-thread count. Hiding it (or the file tree) gives the rail room.
  - **Highlights:** text through the CSS Custom Highlight API (no DOM edits in the rendered article); blocks and boxes through a `data-comment` attribute the stylesheet tints. Hovering a card strengthens its anchor's tint; clicking a highlight focuses its card.
  - **Starting a comment:** a selection in prose shows a comment button in the rail at its top, and `c` opens the composer, as in the diff. Hovering a block shows the same button at its top; a diagram box outlines on hover and a click opens the composer. `Escape` closes it through the store's `escape()`.
  - **Stale threads:** after the last section, under "Not in this tour", full width; the header counts them beside the stale diffs.
  - The diff view's comment panel lists tour threads; opening one switches to the tour and scrolls its anchor to the gaze line, focusing its card.
- **Rejected:**
  - Cards inside the column next to their block. They'd squeeze 920px prose and diffs.
  - The rail only while threads exist. The article would jump sideways on the first comment and back on the last delete.
  - Threads in the contents panel instead of a margin. They'd lose their place beside the text, which is the point of the screenshot.
- **Why:** A document reader expects comments beside the passage, as in the screenshot; the inline fallback is the diff's own layout, so a narrow window still works.

### 5. One draft, one composer: the draft names a code range or a tour target

- **Chosen:** `Draft` becomes `{kind: 'code', path, selection} | {kind: 'tour', node, on, quoted?, occurrence?}`. `CommentComposer` renders both; suggestions and the permalink stay with code line drafts. `composerKey` keys a tour draft by its target, so text left with `Escape` comes back. `submitDraft` posts a tour draft to `POST /api/tour/threads` (`TourThreadCreate`), which answers the thread; replies, edits, resolve and delete use the existing thread routes.
- **Rejected:** Extending `ThreadCreate`. It is released (`--comments` import files, agent scripts) and refines on `path`; a separate body keeps it as is.
- **Why:** The same components and store actions, with the differences at the two edges: what a draft targets and where it is posted.

### 6. The agent answers a thread with `diffle comments reply`

- **Chosen:** `diffle comments reply <thread-id> <body|->` (stdin with `-`) posts to `POST /api/threads/{id}/replies` with `author: "agent"` and prints the thread as JSON, for code and tour threads alike. A thread the shown set lacks or an empty body exits 2 with the reason. `--skill`'s "Read and answer the review's comments" documents it.
- **Rejected:** No reply command (this plan's first draft): the agent could read threads but answer only in its own chat, so the reviewer's question in diffle got its answer elsewhere.
- **Why:** The reviewer asked for threads "the agent can read and respond to". The route and the agent mark already exist; only the command was missing.

### 7. Ship in four slices: the reply, then the server, then the client

- **Chosen:** The order under **Delivery**.
- **Why:** As for tours: the reply, anchor, relocation and prompt are testable with insta before any UI exists.

## Interfaces and files

```
POST /api/tour/threads   TourThreadCreate {node, target, body} → 201 CommentThread; 400 without a tour, or when the target is not in it
```

```
src/shared/protocol.ts                     MODIFIED  TourAnchor in CommentAnchor; TourTarget, TourTargetRequest, TourThreadCreate
crates/diffle/protocol.generated.json      MODIFIED  regenerated
crates/diffle/src/tour/anchor.rs           NEW       a tour's targets: reading text, labels, sections, finding and relocating
crates/diffle/src/comments/tour.rs         NEW       CommentStore::relocate_tour: move or stale the tour threads
crates/diffle/src/comments/format.rs       MODIFIED  the tour block (decision 3)
crates/diffle/src/comments/anchor.rs       MODIFIED  order: code threads, then tour threads in document order
crates/diffle/src/comments/relocation.rs   MODIFIED  skip tour anchors on a refresh
crates/diffle/src/comments/store.rs        MODIFIED  --path matches code threads only
crates/diffle/src/github/review.rs         MODIFIED  skip tour threads
crates/diffle/src/server/routes/tour.rs    MODIFIED  POST /api/tour/threads; relocate on push, stale on clear
crates/diffle/src/cli/skill.rs             MODIFIED  the reply command; the tour anchor
crates/diffle/src/cli/args.rs, agent/      MODIFIED  diffle comments reply
crates/diffle/tests/tour_comments.rs       NEW       create, relocate across pushes, clear, prompt and list (insta)
src/client/api.ts                          MODIFIED  createTourThread
src/client/comments/threads.ts             NEW       a thread's file, review order, a tour thread's label
src/client/store.ts, model.ts              MODIFIED  Draft union, composerKey, anchorLabel, submitDraft
src/client/tour/anchor.ts                  NEW       selection ↔ anchor, reading text, Ranges for highlights
src/client/tour/Margin.tsx                 NEW       the rail: cards, composer, comment button
src/client/tour/placement.ts               NEW       cards' tops from anchors and heights (decision 4)
src/client/tour/render.tsx, primitives/    MODIFIED  data-node on rendered elements and diagram shapes
src/client/tour/TourPage.tsx, TourView.tsx MODIFIED  column + rail, inline mode, stale group, header count
src/client/tour/Contents.tsx               MODIFIED  open-thread count per section
src/client/review/CommentCard.tsx          MODIFIED  no export for tour threads; Markdown without a path
src/client/review/CommentComposer.tsx      MODIFIED  tour drafts
src/client/comments/ThreadRow.tsx          MODIFIED  open a tour thread in the tour
src/client/styles/tour.css                 MODIFIED  rail, highlights
test/e2e/tour.spec.ts                      MODIFIED  comment on prose, a box and a block; margin and inline screenshots
```

## Delivery

0. `diffle comments reply` and its `--skill` section. Verify: `pixi run test-rust` (insta: the replied thread, `--skill`).
1. Contract, store, route, relocation on push and clear, prompt, list, GitHub skip, `--skill`. The client compiles, with tour threads listed in the comment panel. Verify: `pixi run test-rust`, `pixi run test-node`.
2. Text comments in the margin: selection, `c`, composer, cards, highlights, placement, stale group, opening from the comment panel. Verify: `pixi run e2e -g 'the tour'`, the comment scenarios touched.
3. Element comments (blocks, diagram boxes), the inline narrow layout, section counts in the contents. Verify: as slice 2.

Each slice ends with `pixi run lefthook-run`, `pixi run build-release`, and updates `plans/tours.md` decision 7 and its follow-up.

## Open questions

None.
