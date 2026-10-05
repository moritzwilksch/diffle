---
title: Agent hand-off
description: Turn your review comments into a prompt for a coding agent.
sidebar:
  order: 5
---

diffle turns your open threads into a plain-text prompt that a coding agent can act on.

## Get the prompt

- **Close the last diffle tab.** diffle stops and prints the prompt to stdout. Status messages go to
  stderr, so stdout carries only the prompt:

  ```bash
  claude "$(diffle main)"
  diffle main > review.md
  ```

  `Ctrl+C` stops diffle and prints the prompt too. With `--keep-alive`, closing the tab leaves diffle
  running.

- **Press `yy`** (or `Y`), or click **All** in the Threads header, to copy the prompt to the
  clipboard without stopping.
- **Copy one comment** with the copy icon on its card.

The prompt holds the open threads of the comparison you're looking at. Resolved threads are left
out.

## Format

One block per thread, sorted by file and line, each ending with `---`:

````text
tally/ledger.py:33-34

>         amount = self.unit_price * self.quantity
>         return -amount if self.kind == "refund" else amount

Totals round per currency afterwards. Does a refund in another currency than its sale still net out?

---

tally/ledger.py:77

>     kind = (row.get("kind") or "sale").strip().lower()

Normalise once here so the check below stays simple:

ORIGINAL:
```
    kind = (row.get("kind") or "sale").strip().lower()
```
SUGGESTED:
```
    kind = (row.get("kind") or "sale").strip().casefold()
```

---

(file) tally/refunds.py

Missing a test for a partial refund.

---
````

- A line thread starts with `path:line` or `path:start-end`, then quotes the lines it is on.
- A file thread starts with `(file) path` and quotes nothing.
- A thread on removed lines is prefixed `(removed)`; a [stale](./threads.md#threads-follow-the-code)
  one `(stale, was line N)`.
- Replies follow the first message, separated by blank lines.
- A `suggestion` block becomes an `ORIGINAL` / `SUGGESTED` pair.

## Let an agent add comments

The running server accepts new threads over HTTP, so a script or an agent can leave comments that
show up in the review right away. Post one thread, or an array of them, to `/api/threads` on the
address diffle printed at startup (port 4966 unless it was taken):

```bash
curl -X POST http://127.0.0.1:4966/api/threads \
  -H 'content-type: application/json' \
  -d '{"path": "tally/ledger.py", "startLine": 33, "endLine": 34, "body": "Is this covered by a test?"}'
```

| Field       | Meaning                                                                         |
| ----------- | ------------------------------------------------------------------------------- |
| `path`      | The file. Required.                                                             |
| `startLine` | First line. Leave it and the next three fields out to comment on the file.      |
| `endLine`   | Last line. Defaults to `startLine`.                                             |
| `side`      | `new` (default) or `old`.                                                       |
| `quoted`    | The lines' text as the agent saw it. diffle reads it from the diff if left out. |
| `body`      | The comment, in Markdown. Required.                                             |

diffle skips a thread that duplicates an open one. `GET /api/threads/export` returns the prompt,
the same text `yy` copies.
