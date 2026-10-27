---
name: diffle-review
description: Review a diff through a running diffle: read what it shows, comment on lines, and push a report with findings that do not fit a line. Use when asked to review changes in diffle, annotate a diff, or leave review notes the reviewer sees beside the code.
---

# Review in diffle

diffle is a local review server. While it runs for a repository, everything you do goes through its HTTP API; the reviewer sees comments inline in the diff and reports in the **Reports** view (`gr`), and can hand your comments to GitHub or copy them as a prompt.

## Find the server

```bash
cat "$(git rev-parse --absolute-git-dir)/diffle/server.json"   # {"url":"http://127.0.0.1:4966/","pid":…}
```

No file, or no answer at the url: nobody is reviewing yet. Start one in the background and read the file again:

```bash
diffle main...HEAD --no-open --keep-alive &    # or `diffle working`, `diffle pr 27`, `diffle show <rev>`
```

Every path below is relative to that url. Send JSON bodies with `content-type: application/json`.

## Read the review

| Request | Gives |
|---|---|
| `GET api/snapshot` | `changed` (path, status, additions, deletions, oldPath), `oldSha`, `newSha`, `review` |
| `GET api/patch` | every changed file's patch, one unified diff |
| `GET api/patch?path=<path>` | one file's patch |
| `GET api/file?path=<path>&rev=new` | a whole file on the new side (`rev=old` for the old one) |
| `GET api/threads?state=open` | comments already there; do not repeat one |

Line numbers you quote are the new side's, as the file reads after the change, unless you comment on a removed line (`side: "old"`, old-side numbers).

## Comment on lines

`POST api/threads` takes one comment or an array. A comment lands under its last line; the reviewer sees it where the code is.

```json
[
  { "path": "src/app.py", "startLine": 42, "endLine": 44, "body": "The refund path skips validation here." },
  { "path": "src/app.py", "startLine": 50, "body": "```suggestion\nreturn total.quantize(CENT)\n```" },
  { "path": "docs/guide.md", "body": "Whole-file note: this page still names the old command." }
]
```

- `startLine` alone comments one line; without it the comment is on the file as a whole.
- A ```` ```suggestion ```` fence proposes a replacement for the commented lines; it becomes a suggestion on GitHub.
- The reply is the created threads. A line the diff does not show is refused with a message; move the comment to a shown line or leave it on the file.
- Keep comments short and specific. One finding per comment; say what to change, not only what is wrong.

## Push a report

For findings that belong to no line, or a view of the whole change (a summary, a risk ranking, a dependency table, rendered output), push a report. It shows under **Reports** and goes stale, not away, when the diff moves on.

```bash
diffle report put notes.md                        # the file's first heading is the title
diffle report put notes.md --anchor src/app.py:42  # the block points at a line; Enter opens it, c comments there
diffle report put review.json                      # a whole report: several blocks, rendered pages
```

Over HTTP: `PUT api/reports/<id>` with `{ "title": "…", "blocks": [ { "kind": "markdown", "text": "…", "anchor": { "path": "src/app.py", "line": 42 } } ] }`. The id is lowercase letters, digits and dashes; putting it again replaces the report. Files a `pages` block names go up first with `PUT api/reports/<id>/files/<path>` (raw image bytes). A 409 with `current` in the body means the diff moved on since you read it: read it again, then put again, naming `current` as `target` or leaving `target` out.

`diffle report put --help` shows the full JSON.

## Do this, in this order

1. Find or start the server. Read the snapshot and the patches; read whole files where the patch is not enough.
2. Comment on the lines that need a change. Check `api/threads` first so you add to the review instead of repeating it.
3. Push one report named for what it is (`summary`, `risks`, `deps`) with what does not fit a line, each block anchored where it can be.
4. Say what you commented on and what the report holds; the reviewer takes it from there. Never submit to GitHub yourself: the reviewer does that from diffle.
