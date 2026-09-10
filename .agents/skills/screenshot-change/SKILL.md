---
name: screenshot-change
description: Capture cropped before/after screenshots of diffle UI changes and attach them to a PR. Use when asked to screenshot the UI, add screenshots to a PR or description, or demonstrate a client change visually.
---

# Screenshot a UI change

Capture the smallest image that proves each change, then attach it. Three moves keep it fast and cheap: **crop** at capture time, **seed** server state over HTTP instead of clicking, and **swap** the client build to get the before frame.

Read back only the crops. A 500×200 crop costs a fraction of a 1440×900 frame, and the frame is mostly unchanged code.

## Workflow

1. **Prepare a throwaway repo with a diff.** Keep it outside the checkout and pass it with `-C`. The diff must contain the lines and files the change touches; content only needs to be realistic enough to render. Completion: `git -C <repo> diff <range>` shows the changed files.
2. **Build the client once.** `npm run build:client` (or `buildClient()`). The server serves `dist/client`; server code rarely affects a screenshot.
3. **Capture the after state** with a short scenario script that imports the harness (see [below](#harness)). Seed the state the server can hold (threads, viewed, resolved) over HTTP; drive only state that has no endpoint (menus, selections, the composer). Completion: every change has a crop named for it.
4. **Capture the before state** by swapping the client build, not by rebuilding a second worktree from scratch. Add a worktree at the base commit, share this checkout's dependencies (`ln -s "$PWD/node_modules" <worktree>/node_modules`), build it there (`npm run build:client`), then `installClient('<worktree>/dist/client')` and re-run the scenario. Restore with `buildClient()`. Completion: each after crop has a before crop from the same selector.
5. **Attach the crops.** Put local image paths in the PR body, for example in a `| Before | After |` table with alt text. Pass the body and every referenced image to `gh pr edit` (or `gh pr create`):

   ```sh
   gh pr edit PR-NUMBER --body-file pr-body.md \
     --attach /tmp/shots/sidebar-before.png \
     --attach /tmp/shots/sidebar-after.png
   ```

   GitHub CLI uploads the files and rewrites their local references to GitHub URLs. It can also append unreferenced attachments. See [Attaching files with GitHub CLI](https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli). Completion: the PR body renders every pair.
6. **Verify** by reading one crop per change. Completion: the pixels show the stated difference; re-capture rather than describe a mismatch.

## Efficiency rules

- **Crop, don't frame.** `crop(page, selector, path)` screenshots one element. Use `clip(page, box, path)` for a region the element API cannot express. Fall back to a full frame only to find a selector.
- **Seed, don't click.** `seedThreads(url, threads)` sets up the sidebar in one request. Driving the same state through the UI is slower and flakier.
- **Swap, don't clone.** For client-only changes, build the base client into a worktree and copy its `dist/client` over the served one. No second server.
- **One browser, many pages.** `newPage` makes a fresh context per capture, so client state resets without restarting the browser.
- **Wait for a signal, not the clock.** Prefer `locator.waitFor()` over `waitForTimeout`; keep timeouts only for animations.

## Scripts

- `scripts/harness.mjs` — browser, diffle server, seeding, diffle-specific interactions.

## Harness

`scripts/harness.mjs` exports the pieces a scenario needs. Run it with `node` (ESM).

| Export                                                 | Does                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `openBrowser()`                                        | Launches Chromium, handling library paths and Playwright discovery.            |
| `newPage(browser, url, opts)`                          | Fresh context at the default 1440×900 viewport, waits for the viewer.          |
| `startDiffle({ repo, revs, args })`                    | Runs diffle on `repo` for `revs`; returns `{ url, stop() }`.                   |
| `withDiffle(opts, fn)`                                 | Same, with guaranteed cleanup.                                                 |
| `seedThreads(url, threads)`                            | `POST /api/threads`, one request for many threads.                             |
| `buildClient()` / `installClient(dir)`                 | Build this checkout; copy a build into the served `dist/client`.               |
| `crop(page, selector, path)` / `clip(page, box, path)` | Write a cropped PNG.                                                           |
| `selectLines(page, from, to, side?)`                   | Drag the number column to select lines and open the composer.                  |
| `openModePicker(page, entry?)`                         | Open the compare menu and pick `Working`, `Two refs`, `Last commits`, or `PR`. |

A scenario is a few lines:

```js
import {
  withDiffle,
  openBrowser,
  newPage,
  seedThreads,
  crop,
} from '/path/to/diffle/.agents/skills/screenshot-change/scripts/harness.mjs';

const OUT = '/tmp/shots';
await withDiffle({ repo: '/tmp/demo', revs: ['HEAD~1..HEAD'] }, async ({ url }) => {
  await seedThreads(url, [{ path: 'src/app.py', startLine: 4, body: 'Why?' }]);
  const browser = await openBrowser();
  const page = await newPage(browser, url);
  await crop(page, 'aside >> nth=-1', `${OUT}/sidebar-after.png`);
  await browser.close();
});
```

Import the harness by absolute path: a scenario's relative imports resolve against the scenario file, not the repository root.

### Selectors

The viewer renders into a shadow root, so `page.evaluate`'s `querySelector` misses it while Playwright locators pierce it. Useful hooks:

- `[data-column-number]` — a line-number cell; `data-line-type` is `change-addition`, `change-deletion`, or `context`; `data-thread-line` marks commented lines.
- `[data-diffs-header]` — a file header (diff list and full-file view).
- `.codeview` — the viewer; wait on it after navigation.
- `#mode-picker` and `#mode-config` — the compare menu and its side pane.
- `button[title="View full file (F)"]`, `button[title="Collapse / expand"]` — header actions.
- `aside >> nth=-1` — the threads sidebar (`aside` alone matches the file tree first); `.panel .item` — one thread.

## Setup

Install Playwright once and let the harness find it. `gh pr create` and `gh pr edit --attach` require push access to the repository:

```sh
npm install --global playwright && playwright install chromium --only-shell
```

- `PLAYWRIGHT_MODULE` points at a specific playwright `index.mjs`.
- `PLAYWRIGHT_LIBS` prepends a `lib` directory with Chromium's shared libraries (`libnspr4`, `libnss3`) on minimal Linux images.
