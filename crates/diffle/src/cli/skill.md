# diffle

diffle is the reviewer's diff viewer, running in the browser beside you. The commands below talk
to the diffle serving the repository you are in, or the one `-C <path>` names: a run announces
itself in `<git-dir>/diffle/server.json`. Without a run they exit 2 with "no diffle is running for
this repository"; ask the reviewer to start one (`diffle` in the repository).

## Read and answer the review's comments

`diffle comments list [--state open|resolved|all] [--path <path>]` prints the threads the reviewer
is shown as one JSON document: `commentKey`, the set they belong to, and `threads`, each with its
`id`, its anchor and its messages. A message you wrote carries `"author": "agent"`. An anchor
is on code (`line`: a path and a line range on the `old` or `new` side; `file`: a whole file) or on
your tour (`tour`). A tour anchor names the section by `step` and `section`, its heading, and the
element as a refused push names it. Its `target` is a selection in that element's text
(`on: "text"`, the words in `quoted`) or the element as a whole (`on: "element"`, with its
`label`: a card's title, a box's text). Find the passage in your document by these. A tour thread is
`stale` when your last push no longer holds its passage.

`diffle comments reply <thread-id> <body|->` adds your reply to a thread, in Markdown (stdin with
`-`), and prints the thread as JSON. The reviewer sees it marked as yours. Reply to answer a
question or to say what you changed; when the answer is a change, make it first, then reply.

## Give the reviewer a tour

A tour is one HTML document that walks the reviewer through the change, read as an article: an
optional `<h1>` title, then sections. Each `<h2>` starts a section, and the sections are the steps
of the walk: the reviewer moves between them with `n` and `p`, and the side panel lists them with
their `<h3>` subsections. Each review has one tour.

- `diffle tour push [<file>|-]` checks the document (stdin without a file) and shows it in place
  of the review's tour, and prints the stored tour as JSON. A refused document exits 2, lists
  every reason as `<element>: <reason>`, and leaves the previous tour in place; fix them all and
  push again.
- An accepted push can come back with warnings on stderr, in the same form, such as a diagram
  label that may run past its box. They are judgment calls: fix each, or keep it knowingly.
- `diffle tour clear` removes the review's tour.
- The reviewer answers in this chat, or comments on the tour in diffle: list the threads, reply to
  a question, and revise the document and push it again for a change. The open tour updates in
  place, and each thread follows its passage into it. A diff whose lines left the review since says
  so in place.

### Structure

- The order is part of the explanation. Give each step of the walk an `<h2>`, in the order that
  explains the change best, and use `<h3>` for parts of a long section. Headings sit at the top
  level of the document.
- Between headings, write prose and lists, and place blocks: a `diffle-card`, a `diffle-diff`, a
  `diffle-walk`, a `diffle-trace`, a `diffle-diagram`, a table, a `diffle-tree`, a
  `diffle-callout`. A block sits between paragraphs, never inside one.
- Use a `diffle-card` to explain one part of the diff next to its code: a title, a sentence or
  two, and its `diffle-diff`s. Use plain prose and the other blocks for the rest. No card goes
  inside another, and a heading never goes inside a card.
- Put two or three blocks or short prose columns side by side in a `diffle-row` when they belong
  together: a table beside the prose about it, or two small diagrams to compare. Each column is a
  block, or prose in a `<div>`, `<p>`, `<ul>` or `<ol>`, and a row sits at the top level. Keep
  diffs and cards with diffs full width: in a row their lines may wrap. A narrow window stacks a
  row's columns.
- Keep a diff to at most about 12 lines, and split a long story into more sections.
- Use a `diffle-callout` for what the reviewer should not miss; it holds prose, not headings. Pick
  `info` for context, `warning` for something the reviewer should check, and `danger` for a likely
  bug or breaking change, and only where the diff supports it.
- Close every `diffle-*` element with its end tag: HTML ignores `/>` on them.
- Paths are relative to the repository root and must be files of the review. Line numbers count on
  the side you name: `new`, the file after the change, by default.
- diffle styles the tour: no `style`, scripts or images, and `class` only inside a diagram.
- Mark every code symbol your prose names with a `diffle-symbol` when it has a line in the review
  to point at: the reviewer sees it coloured as in the diff, hovers it for its signature, and
  clicks it for its references. Keep `<code>` for what is not a symbol: paths, commands, literals.
- Hover and references need the language server for the symbol's file, and the `new` side. Without
  them the chip is coloured code only. Run `diffle lsp` to see which languages have a server.

### Writing

The reviewer reads your words inside diffle, so hold them to its bar as a product. Write like a
senior colleague explaining the change across a table: lead with the point, use plain and exact
words, and keep sentences short and active. Name what the diff shows, such as names, numbers and
consequences, instead of adjectives. State only what the diff supports, and never invent a
rationale. Cut filler, stacked hedges, reflexive triads, windups such as "Here's the thing:",
and closing summaries. Skip stock phrasing such as "delve", "robust", "seamless",
"crucial", "leverage" and "it's worth noting". Use straight quotes, no em dashes, and
no emoji. A section opens with a sentence or two on what it shows; a card is its title and one or
two sentences. Let the diff show the code. A tour walks the change itself: leave its tests out
unless the reviewer asks for them.

### Walks

Use a `diffle-walk` when one piece of code reads best part by part, in order: a loop, a request
handler, a pipeline. The reader steps through its notes; each lights its lines, dims the rest, and
shows its text under them. Use a `diffle-card` for a diff that a sentence or two explain, and prose
for what spans several files.

- Give the walk the lines of that one piece, 40 at most, and one `diffle-note` per step in reading
  order, about 6 at most.
- A note's `lines` lie within the walk's, count on its side, and share none with another note.
- A note is a title of a few words and one sentence, held to the Writing rules: say what its lines
  do or why, never read them back. It holds inline prose only: text, `<code>`, `diffle-symbol`,
  `diffle-jump`, `diffle-icon`.

```html
<diffle-walk path="src/retry.rs" lines="20-41">
<diffle-note lines="20-24" title="Check the budget">The loop stops once <diffle-symbol path="src/retry.rs" line="21" name="attempts"></diffle-symbol> reaches the limit.</diffle-note>
<diffle-note lines="26-33" title="Back off">Each failure doubles the wait, up to 30 seconds.</diffle-note>
<diffle-note lines="35-41" title="Give up">The last error goes back to the caller unchanged.</diffle-note>
</diffle-walk>
```

### Traces

Use a `diffle-trace` to follow one request or call through several places in call order: a
handler, the function it calls, where the result lands. Each `diffle-stop` names a `path` and a
`line` the review has, and holds one sentence on what happens there; diffle shows a few lines
around it with the line lit, and the reader steps from stop to stop. Keep to the places the point
needs, about 6 at most. One place read part by part is a walk; one place with a sentence is a card.

```html
<diffle-trace>
<diffle-stop path="src/routes.rs" line="40">The route reads the token from the header.</diffle-stop>
<diffle-stop path="src/auth.rs" line="12">Validation compares its expiry with the clock.</diffle-stop>
</diffle-trace>
```

### Icons

Use a Lucide icon to mark one kind of thing the same way throughout the tour, such as a database
or a network call; never as decoration. Find names at lucide.dev/icons; a push refuses a name
diffle does not know and suggests the closest. In text, `<diffle-icon name="database"></diffle-icon>`
sits at the text's size and colour: in prose, a heading, a table cell or a callout. `tone` colours
it. A card takes one before its title with `icon`. A diagram takes them too, below.

### Interfaces

Use a `diffle-code` to show what a collaborator offers and takes: signatures, interfaces, type
definitions, the shape of an abstraction. Elide bodies (`;` or `{ … }`) and leave private details
out. Code the change touches belongs in a `diffle-diff`; never repeat it in a code block. With
`path` and `line`, point at where its first declaration sits on the new side; without `path`, give
`lang`. Write `<` as `&lt;` and `&` as `&amp;`. diffle warns when a block repeats the diff, runs
past about 12 lines, or does not match its line. Set collaborators side by side in a row:

```html
<diffle-row>
<diffle-code path="src/auth.rs" line="12">pub fn validate(token: &amp;Token, now: Instant) -&gt; Result&lt;Claims&gt;;</diffle-code>
<diffle-code lang="rust">
pub trait TokenStore {
    fn get(&amp;self, id: &amp;str) -&gt; Option&lt;Token&gt;;
}
</diffle-code>
</diffle-row>
```

A diagram box can carry code too: a `<text class="code" lang="rust">` with one `<tspan>` per
line, 16 apart, each 6 units per character wide:

```html
<rect x="8" y="8" width="264" height="44"/>
<text x="16" y="22" class="code" lang="rust"><tspan x="16" dy="0">trait TokenStore {</tspan><tspan x="16" dy="16">    fn get(&amp;self, id: &amp;str) -&gt; Token; }</tspan></text>
```

### Examples

Add `example` to a `diffle-code` for a snippet you make up, never code from the repository. Use one
for three things: data as it flows through the system (a request, a response, a token, a config,
the order of calls), a simplified spike of an idea, or an alternative design the reviewer could
weigh. diffle labels it as an example, beside its `title`. Changed code always goes in a
`diffle-diff`, never re-typed in an example; signatures stay a plain `diffle-code`. Keep an example
minimal and realistic: the fields the point needs, with plain placeholder values, and never a real
secret. An example takes `lang` and no `path` or `line`. diffle warns when it may re-type the diff
or runs past about 20 lines.

```html
<p>A login answers with a token the next request carries:</p>
<diffle-code lang="json" example title="Response to POST /login">
{ "token": "eyJhbGciOi...", "expiresAt": "2026-01-01T12:00:00Z" }
</diffle-code>
```

### Diagrams and tables

Draw a `diffle-diagram` to show how parts connect; use a table to compare options or map one thing
to another. Put its caption in the prose before it. A table is plain HTML:
`table`, `thead`, `tbody`, `tr`, `th` and `td`, with `colspan` and `rowspan` on a cell.

A diagram holds one `<svg viewBox="0 0 <width> <height>">` that you draw by hand; one unit is
one pixel, and the text takes the UI's own fonts and sizes, small enough to fit many parts across.
diffle styles it from the classes below and the theme, and draws the arrowheads, so write no
`style`, `fill`, `stroke`, font or marker attributes and no `<defs>`.

- Make one point per diagram, and draw only the parts it needs. It shows at its own width and
  never larger; keep it 920 wide or less, the page's column, or a row's column width, or it
  shrinks, text and all. 920 holds seven 96-wide boxes with 32 between them.
- Place parts on a grid: snap to 4, keep one column and row pitch, and give the boxes in a row the
  same height and gaps; 24 to 40 between boxes reads well.
- Text is centred vertically on its `y`, not set on a baseline. Lay out a node from its corner
  (x, y): a lone name at (x+8, y+14) in a box 28 tall, the box's middle; with a detail line, the
  name at (x+8, y+12) and the detail at (x+8, y+28) in a box 40 tall. Make the box 16 wide plus 6
  per character of its longest line (5.5 in `small`), so 8 units of padding stay on each side.
  Names are regular weight unless you add `bold`. Keep names to three words or fewer, in sentence
  case, without a period.
- Put a box and its text in a `<g>`, so a tone on the group colors all of it.
- Draw an icon in a node as `<svg data-lucide="database" x="…" y="…"/>`, 14 square: at (x+8, y+7)
  beside a lone name in a box 28 tall, or (x+8, y+13) beside a name and detail in a box 40 tall,
  with the text at x+28 and the box 20 wider. Give every sibling box an icon, or none. It takes
  its text's colour, or its group's tone.
- Keep one main direction of flow. Start and end each line at the middle of a box side, square to
  it, with at most two bends and no crossings. Put a line's label 10 above a horizontal line or 8
  right of a vertical one, never on it.
- Name a region with a `frame` rect and an `eyebrow` text at (x+8, y+12).
- Tone at most about a third of the nodes, and only those the point is about.

Step through a diagram when its parts happen in an order the reader should follow: a request's
trip, a pipeline's stages. Give each `<g>` a step lights `step="n"`, numbered from 1 without a
gap, and after the `<svg>` put one `diffle-note` per step, in order: a title and one sentence, held
to the Writing rules. A step lights its groups and dims the others, and its note shows under the
drawing. A diagram whose parts all matter at once needs no steps; one piece of code read in order
is a walk.

```html
<diffle-diagram><svg viewBox="0 0 232 52">
  <g step="1"><rect x="8" y="12" width="88" height="28"/><text x="16" y="26">Login</text></g>
  <g step="2"><path d="M96 26 H136" class="arrow"/><rect x="136" y="12" width="88" height="28"/><text x="144" y="26">Validate</text></g>
</svg>
<diffle-note title="Login issues a token">The token carries its expiry.</diffle-note>
<diffle-note title="Every request checks it">An expired token is refused.</diffle-note>
</diffle-diagram>
```
