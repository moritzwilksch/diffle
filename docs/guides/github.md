---
title: GitHub
description: Review pull requests and send your comments to a pending GitHub review.
sidebar:
  order: 6
---

## Tokens

diffle takes a GitHub token from `GITHUB_TOKEN`, then `GH_TOKEN`, then a signed-in
[`gh`](https://cli.github.com/) (`gh auth token`). Without one, everything except GitHub still
works.

`GITHUB_API_URL` points diffle at another GitHub API, as in GitHub Actions.

## Open a pull request

```bash
diffle pr 27                                         # by number
diffle pr https://github.com/owner/repo/pull/27      # by URL
diffle pr                                            # the current branch's pull request
```

Or choose **PR** in the [mode picker](./choosing-a-comparison.md#with-the-mode-picker). diffle
fetches the pull request's base and head into its own refs under `refs/diffle/`, so your branches
and remotes stay untouched. It compares them the way GitHub does, from the merge base. A pull
request from another repository opens in a temporary clone.

A pull request records an [iteration](./iterations.md) each time you open it after a push, so you
can review just what changed since last time.

The **GitHub** button in the header (`o`) links to the repository and the pull request. diffle also
finds the pull request for a branch comparison such as `diffle main...feature` when both branches
track GitHub remotes.

## Send comments to a pending review

When the comparison matches a pull request, threads get a pull request icon:

- the icon on a thread adds that thread;
- the icon in the Threads header adds every open thread.

Both ask for a second click to confirm. The comments land in your **pending review** on the pull
request. diffle never submits it: you edit, drop, and submit the comments on GitHub yourself.
Adding a thread again updates its comment instead of duplicating it.

Export only works when your comments sit where GitHub can anchor them. Otherwise the icons don't
appear, and the **GitHub** menu (`o`) says why. That happens when:

- the pull request is not open;
- the comparison includes your worktree, or doesn't end at the pull request head (for example,
  after unpushed commits);
- the comparison doesn't match the pull request's diff.

[Stale](./threads.md#threads-follow-the-code) threads are skipped.
