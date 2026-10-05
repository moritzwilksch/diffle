---
title: Storage
description: What diffle writes to disk, and what is safe to delete.
sidebar:
  order: 4
---

diffle never changes your worktree, your index, or your branches. It writes only these:

| Location                           | Holds                                                                |
| ---------------------------------- | -------------------------------------------------------------------- |
| `<git-dir>/diffle/comments.json`   | Threads and viewed marks, one set per comparison                     |
| `<git-dir>/diffle/iterations.json` | Recorded [iterations](../guides/iterations.md), per range            |
| `refs/diffle/iterations/…`         | Pins that keep each iteration's commits from being garbage-collected |
| `refs/diffle/<session>/…`          | Pull request refs that diffle fetched; removed when diffle stops     |
| `~/.config/diffle/config.json`     | The [user config](./configuration.md)                                |

`<git-dir>` is usually `.git`; `git rev-parse --git-dir` prints it. In a linked worktree it is that
worktree's own Git directory, so each worktree keeps its own comments.

Each comparison keeps its comments under its own key, so `diffle main...feature`,
`diffle main..feature`, and `diffle show <commit>` don't share threads.

Several diffle instances can run on one repository at once: every write re-reads the file under a
lock, so they don't overwrite each other.

## Start over

To drop every comment, viewed mark, and iteration in a repository:

```bash
rm -rf "$(git rev-parse --git-dir)/diffle"
git for-each-ref --format='%(refname)' refs/diffle/ | xargs -n1 git update-ref -d
```

To drop only some of it, use the delete buttons in the Threads list and the Iterations box instead.
