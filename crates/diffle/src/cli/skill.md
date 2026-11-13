---
name: diffle
description: Show and talk through code changes with the user in diffle, the diff viewer open in their browser. Read and answer their review comments, and push a guided tour of a change. Use when the user wants to see, review, walk through or explain changes, or collaborate in diffle.
---

# diffle

diffle is the reviewer's diff viewer, open in their browser. These commands talk to the diffle
serving the current repository, or the one `-C <path>` names; a run announces itself in
`<git-dir>/diffle/server.json`. If none runs, they exit 2 with "no diffle is running for this
repository": ask the reviewer to run `diffle` in the repository.

## Writing

The reviewer reads your replies and tours inside diffle, so hold them to its bar as a product, in
the little space its panels give. Write like a curious, direct colleague explaining the change
across a table: lead with the point. Use plain, everyday words in short, active sentences, and pick
the exact verb and the concrete fact over adjectives and abstract nouns. Cut every word that adds no
meaning, but stay concise, not telegraphic. Name what the diff shows, such as names, numbers and
consequences, and explain a change by contrast: the old behaviour beside the new. State only what
the diff supports, and never invent a rationale. Cut filler, stacked hedges, reflexive triads,
windups such as "Here's the thing:", and closing summaries. Skip stock phrasing such as "delve",
"robust", "seamless", "crucial", "leverage" and "it's worth noting". Use straight quotes, no em
dashes and no emoji.

## Comments

`diffle comments list [--state open|resolved|all] [--path <path>]` prints the threads the reviewer
sees as one JSON document: `commentKey`, the set they belong to, and `threads`, each with its `id`,
anchor and messages. Your messages carry `"author": "agent"`. An anchor is one of:

- `line`: a path and a line range on the `old` or `new` side.
- `file`: a whole file.
- `tour`: a passage of your tour. `step` and `section` (its heading) name the section; `element`
  names the element by `tag` and `handle` (a card's `id`, a diff's `path:lines`, a note's `title`);
  `within` names the card, tab or walk holding it. `target` is a selection in the element's text
  (`on: "text"`, the words in `quoted`) or the whole element (`on: "element"`, with its `label`: a
  card's title, a box's text). Find the passage in your document by these. The thread is `stale`
  when your last push no longer holds its passage.

`diffle comments reply <thread-id> <body|->` adds your Markdown reply (stdin with `-`), shown to the
reviewer as yours, and prints the thread as JSON. Reply to answer a question or to say what you
changed; if the answer is a change, make it before replying. A tour's threads sit in a narrow
margin beside the passage, so keep a reply to a sentence or two. Put a longer explanation in the
tour, or in this chat when the reviewer asks for one.

## Tours

A tour is one HTML document that walks the reviewer through the change as an article: an optional
`<h1>` title, then sections. Each `<h2>` starts a section, one step of the walk: the reviewer moves
between steps with `n` and `p`, and the side panel lists them with their `<h3>` subsections. Each
review has one tour.

- `diffle tour push [<file>|-]` (stdin without a file) checks the document, makes it the review's
  tour, and prints the stored tour as JSON. A refused push exits 2, lists every reason as
  `<element>: <reason>`, and keeps the previous tour: fix them all and push again. An accepted push
  may print warnings to stderr in the same form, such as a file note that may be long: fix each, or
  keep it knowingly.
- `diffle tour clear` removes the tour.
- `diffle tour export <file>|-` saves the tour as one HTML file that opens offline, as the tour
  view's Export does, for the user to share with people who don't run diffle. The open diffle tab
  bakes it, so it exits 2 without an open tab or a tour.

The reviewer answers in this chat or comments on the tour in diffle. List the threads, reply to
questions, and for a change revise the document and push again. The open tour updates in place, and
each thread follows its passage. A diff whose lines have left the review since says so in place.

### Structure

- Open each section with a sentence or two on what it shows. Let the diff show the code.
- Leave the change's tests out unless the reviewer asks for them.
- Order the `<h2>` steps the way that best explains the change, and split a long section with
  `<h3>`. Headings sit at the top level; inside a card, tab, callout or `<details>`, use `<h4>`.
- Between headings, write prose and lists and place blocks: the `diffle-*` elements below and
  tables. A block sits between paragraphs, never inside one.
- Use a `diffle-card` to explain one part of the diff beside its code: a title, a sentence or two,
  and its `diffle-diff`s. Use prose and the other blocks for the rest.
- Use a `diffle-row` for two or three blocks or short prose columns that belong together: a table
  beside the prose about it, two small diagrams to compare. Use `<div>` only to group prose into one
  column. Keep diffs, and cards with diffs, full width: in a row their lines may wrap.
- Keep a diff to about 12 lines or fewer, and split a long story into more sections.
- Fold into a `<details>` what the main path can do without, such as an edge case or a long aside,
  never what the reviewer needs to follow the change. Its `<summary>` says in a few words what
  opening it shows.
- List files only in a `diffle-tree`, never in a `diffle-code`, a table or a list. The tree shows
  each changed file's status and line counts itself. Title it with what its files are, so trees side
  by side read apart at a glance. Mark where to start or what surprises with `diffle-file` notes, on
  three files at most. To say what every file does, split the files into one tree per role, titled
  with the role, and say the rest in the surrounding prose.
- Use a `diffle-callout` for what the reviewer should not miss, in prose. Pick its `kind` only
  where the diff supports it.
- Close every `diffle-*` element with its end tag: HTML ignores `/>` on them.
- Use paths relative to the repository root, of files in the review. Line numbers count on the
  side you name, `new` by default.
- Write no `style`, scripts or images: diffle styles the tour. Use `class` only inside a diagram.
- Wrap every code symbol your prose names in a `diffle-symbol` when it has a line in the review;
  keep `<code>` for paths, commands and literals. Hover and references need the `new` side and a
  language server for the file (`diffle lsp` lists them); without them the chip is coloured code
  only.

### Walks

Use a `diffle-walk` for one piece of code that reads best part by part, in order: a loop, a request
handler, a pipeline. Each note shows its text under its lines. Use a card for a diff a sentence or
two explain, and prose for what spans several files.

- Give the walk the lines of that one piece, 40 at most, and one `diffle-note` per step in reading
  order, about 6 at most. Notes' `lines` lie within the walk's and never overlap.
- Write a note as a title of a few words and one sentence, held to the Writing rules: say what its
  lines do or why, never read them back.

```html
<diffle-walk path="src/retry.rs" lines="20-41">
<diffle-note lines="20-24" title="Check the budget">The loop stops once <diffle-symbol path="src/retry.rs" line="21" name="attempts"></diffle-symbol> reaches the limit.</diffle-note>
<diffle-note lines="26-33" title="Back off">Each failure doubles the wait, up to 30 seconds.</diffle-note>
<diffle-note lines="35-41" title="Give up">The last error goes back to the caller unchanged.</diffle-note>
</diffle-walk>
```

### Traces

Use a `diffle-trace` to follow one request or call through several places in call order: a
handler, the function it calls, where the result lands. Give each `diffle-stop` one sentence on what
happens there. Keep to the places the point needs, about 6 at most. One place read part by part is a
walk; one place with a sentence is a card.

```html
<diffle-trace>
<diffle-stop path="src/routes.rs" line="40">The route reads the token from the header.</diffle-stop>
<diffle-stop path="src/auth.rs" line="12">Validation compares its expiry with the clock.</diffle-stop>
</diffle-trace>
```

### Tabs

Use `diffle-tabs` for two to four alternatives: the design you chose beside one you rejected, a
payload before and after. Mark a pane with `kind`. A reader may never open a tab, so keep what every
reader needs outside them; state a single alternative as a sentence of prose.

```html
<diffle-tabs>
<diffle-tab title="Expire on the server" kind="chosen"><p>Every check compares the expiry with the clock.</p></diffle-tab>
<diffle-tab title="Expire in the client" kind="rejected"><p>A client with a wrong clock would keep old tokens.</p></diffle-tab>
</diffle-tabs>
```

### Checklists

Use a `diffle-check` for what the reviewer must decide before the change can land: a behaviour you
chose that they may not want, a trade-off the code can't settle. Each `diffle-item` asks one
question; give it `context` for the one fact the answer rests on. Ask only real questions, a handful
at most, each once per tour, and never one the diff already answers.

The reviewer ticks an item as decided or answers it. `diffle comments list` reports each item under
`checks`, with `ticked` and the `thread` that answers it; reply there with `diffle comments reply`.
The prompt carries every open item and every answer. A push that keeps an item's question keeps its
tick.

```html
<diffle-check>
<diffle-item context="Sessions issued before the deploy expire at once.">Should old sessions get a grace period?</diffle-item>
<diffle-item>Is one hour the right lifetime for a token?</diffle-item>
</diffle-check>
```

### Icons

Use a Lucide icon to mark one kind of thing the same way throughout the tour, such as a database or
a network call, never as decoration. Find names at lucide.dev/icons; an unknown name shows a
question-mark placeholder. Place a `diffle-icon` in prose, a heading, a table cell or a callout; give
a card or a tree one before its title with `icon`; draw one in a diagram as shown below.

### Interfaces

Use a `diffle-code` to show what a collaborator offers and takes: signatures, interfaces, type
definitions. Elide bodies (`;` or `{ … }`) and leave private details out. Show code the change
touches in a `diffle-diff`, never in a code block. For real code, give `path`, which diffle names
above the block, and `line`, the new side's line of its first declaration: diffle checks the file
has it and opens the file there. For code that exists nowhere, give `lang` instead. Write `<` as
`&lt;` and `&` as `&amp;`.

Format a block as the language's formatter would at the width it gets, so no line wraps. With
`path`, the block shows no line numbers and has a few more characters:

| Where | Characters | With `path` |
|---|---|---|
| Full width | 110 | 113 |
| A column of a two-column row | 49 | 53 |
| A column of a three-column row | 29 | 33 |
| A card, a tab or a `<details>` | 106 | 109 |

When a signature doesn't fit, put each parameter on its own line and the return type after the
closing parenthesis, as rustfmt and prettier do; diffle warns of a line that wraps. Set
collaborators side by side in a row:

```html
<diffle-row>
<diffle-code path="src/auth.rs" line="12">
pub fn validate(
    token: &amp;Token,
    now: Instant,
) -&gt; Result&lt;Claims&gt;;
</diffle-code>
<diffle-code lang="rust">
pub trait TokenStore {
    fn get(&amp;self, id: &amp;str) -&gt; Option&lt;Token&gt;;
}
</diffle-code>
</diffle-row>
```

A diagram box carries code as a `<text class="code" lang="rust">` with one `<tspan>` per line, 16
apart, each character 6 units wide:

```html
<rect x="8" y="8" width="264" height="44"/>
<text x="16" y="22" class="code" lang="rust"><tspan x="16" dy="0">trait TokenStore {</tspan><tspan x="16" dy="16">    fn get(&amp;self, id: &amp;str) -&gt; Token; }</tspan></text>
```

### Examples

Add `example` to a `diffle-code` for a snippet you make up, never code from the repository, to show
data as it flows through the system (a request, a response, a token, a config, the order of
calls), a simplified spike of an idea, or an alternative design the reviewer could weigh. Keep it
minimal and realistic: only the fields the point needs, plain placeholder values, never a real
secret. Changed code stays in a `diffle-diff` and signatures in a plain `diffle-code`.

```html
<p>A login answers with a token the next request carries:</p>
<diffle-code lang="json" example title="Response to POST /login">
{ "token": "eyJhbGciOi...", "expiresAt": "2026-01-01T12:00:00Z" }
</diffle-code>
```

### Diagrams and tables

Draw a `diffle-diagram` to show how parts connect; use a table to compare options or map one thing
to another. Put the caption in the prose before it.

A diagram holds one `<svg viewBox="0 0 <width> <height>">` you draw by hand; one unit is one pixel,
and text takes the UI's own small fonts, so many parts fit across. diffle styles it from the classes
below and the theme and draws the arrowheads: write no `style`, `fill`, `stroke`, font or marker
attributes and no `<defs>`.

- Make one point per diagram and draw only the parts it needs. It shows at its own width, never
  larger. Keep it within its column, 920 on the page and less in a row, or it shrinks, text and all.
  920 holds seven 96-wide boxes 32 apart.
- Snap parts to a 4-unit grid with one column and row pitch, and give boxes in a row the same height
  and gaps; 24 to 40 between boxes reads well.
- Text centres vertically on its `y`. From a box's corner (x, y): a lone name sits at (x+8, y+14) in
  a box 28 tall; a name and a detail line sit at (x+8, y+12) and (x+8, y+28) in a box 40 tall. Make
  a box 16 wide plus 6 per character of its longest line (5.5 for `small`), leaving 8 of padding
  each side. Names are regular weight unless `bold`, three words or fewer, in sentence case, without
  a period.
- Put a box and its text in a `<g>`, so a tone on the group colours both.
- Draw an icon in a node as `<svg data-lucide="database" x="…" y="…"/>`, 14 square, at (x+8, y+7) in
  a box 28 tall or (x+8, y+13) in a box 40 tall; move the text to x+28 and widen the box by 20. Give
  every sibling box an icon, or none. It takes its text's colour, or its group's tone.
- Keep one main direction of flow. Start and end each line at the middle of a box side, square to
  it, with at most two bends and no crossings. Put a line's label 10 above a horizontal line or 8
  right of a vertical one, never on it.
- Name a region with a `frame` rect and an `eyebrow` text at (x+8, y+12).
- Tone at most about a third of the nodes, only those the point is about.

Step through a diagram when its parts happen in an order the reader should follow, such as a
request's trip or a pipeline's stages. Give each `<g>` the `step="n"` that lights it, numbered from 1
without gaps, and after the `<svg>` put one `diffle-note` per step, in order: a title and one
sentence, held to the Writing rules. A step lights its groups, dims the others, and shows its note
under the drawing. Skip steps when all parts matter at once; one piece of code read in order is a
walk.

```html
<diffle-diagram><svg viewBox="0 0 232 52">
  <g step="1"><rect x="8" y="12" width="88" height="28"/><text x="16" y="26">Login</text></g>
  <g step="2"><path d="M96 26 H136" class="arrow"/><rect x="136" y="12" width="88" height="28"/><text x="144" y="26">Validate</text></g>
</svg>
<diffle-note title="Login issues a token">The token carries its expiry.</diffle-note>
<diffle-note title="Every request checks it">An expired token is refused.</diffle-note>
</diffle-diagram>
```
