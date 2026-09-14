---
name: screenshot-change
description: Capture cropped before/after screenshots or record a video of diffle UI changes. Use when asked to screenshot or record the UI, or to demonstrate a client change visually.
---

# Capture a diffle UI change

Prove each change with the smallest image that shows it. Four moves keep captures fast and repeatable:

- **Crop to the element.** `crop(page, selector, path)` captures one element, `clip(page, box, path)` a region. Read back only the crops: a 500×200 crop costs a fraction of a 1440×900 frame, and the rest of the frame is unchanged code. Frame wide only to find a selector.
- **Seed over HTTP.** `seedThreads(url, threads)` sets up the sidebar in one request. Clicking the same state through the UI is slower and flakier.
- **Swap the build.** `installClient(dir)` points the served `dist/client` at another build, so the before frame needs no second server.
- **Wait on a signal.** `locator.waitFor()` beats `waitForTimeout`; keep timeouts for animations only.

## Screenshots

1. **Prepare a throwaway repo with a diff.** Keep it outside the checkout and pass it with `-C`. Include the lines and files the change touches; content only needs to render. Done when `git -C <repo> diff <range>` lists the changed files.
2. **Build the client once.** `npm run build:client` (or `buildClient()`). The server serves `dist/client`; server code rarely affects a capture.
3. **Capture the after state** with a short scenario that imports the harness ([Harness](#harness)). Seed what the server can hold (threads, viewed, resolved); drive only state with no endpoint (menus, selections, the composer). Done when every change has a named crop.
4. **Capture the before state** by swapping the client build, not by building a second worktree. Add a worktree at the base commit, share dependencies (`ln -s "$PWD/node_modules" <worktree>/node_modules`), build it there (`npm run build:client`), then `installClient('<worktree>/dist/client')` and re-run. Restore with `buildClient()`. Done when each after crop has a before crop from the same selector.
5. **Verify** by reading one crop per change. Done when the pixels show the stated difference; re-capture rather than describe a mismatch.

## Video

Record behavior that unfolds over time: key presses, cursor jumps, collapses. Steps 1 and 2 are the screenshot workflow's.

1. **Record the run.** `newVideoPage(browser, url, { dir })` records at the viewport size, so frames map 1:1 to CSS pixels. Drive it with `page.keyboard`, pausing between beats so a reader can follow. The vim keys are document-level: `gg` first file, `J`/`K` move file, `v` toggle viewed, `zc` collapse.
2. **Assert while recording.** A recording that asserts is a test; one that only shows is a hope. Viewed checkboxes, collapsed chevrons, and tree rows are queryable with pierce-shadow locators ([Selectors](#selectors)). Assert the setup too; stale state silently changes what the run means.
3. **Save and verify.** `saveVideo(context, video, path)` closes the context, converts the recorded webm to mp4, and writes it to `path`. Read a frame before and after the change (`ffmpeg -ss <t> -i clip.mp4 -frames:v 1 f.png`). Done when the transition is on tape; re-record rather than describe a mismatch.

## Harness

`scripts/harness.mjs` exports the pieces a scenario needs. Import it by absolute path: a scenario's relative imports resolve against the scenario file, not the repository root. Run scenarios with `node` (ESM).

| Export                                                 | Does                                                                                           |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `openBrowser()`                                        | Launch Chromium, with the shared libraries and Playwright module resolved.                     |
| `newPage(browser, url, opts)`                          | Fresh context at the default 1440×900 viewport; waits for the viewer.                          |
| `startDiffle({ repo, revs, args })`                    | Run diffle on `repo` for `revs`; returns `{ url, stop() }`.                                    |
| `withDiffle(opts, fn)`                                 | Same, with guaranteed cleanup.                                                                 |
| `seedThreads(url, threads)`                            | `POST /api/threads`, one request for many threads.                                             |
| `buildClient()` / `installClient(dir)`                 | Build this checkout; copy a build into the served `dist/client`.                               |
| `crop(page, selector, path)` / `clip(page, box, path)` | Write a cropped PNG.                                                                           |
| `newVideoPage(browser, url, { dir })`                  | Open a page that records video at the viewport size; returns `{ page, context, video }`.       |
| `saveVideo(context, video, path)`                      | Close the recording context and convert the webm to mp4. Needs system `ffmpeg` with `libx264`. |
| `selectLines(page, from, to, side?)`                   | Drag the number column to select lines and open the composer.                                  |
| `openModePicker(page, entry?)`                         | Open the compare menu and pick `Working`, `Two refs`, `Last commits`, or `PR`.                 |

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

### Selectors

The viewer renders into a shadow root, so `page.evaluate`'s `querySelector` misses it while Playwright locators pierce it. Useful hooks:

- `[data-column-number]`, a line-number cell; `data-line-type` is `change-addition`, `change-deletion`, or `context`; `data-thread-line` marks commented lines.
- `[data-diffs-header]`, a file header (diff list and full-file view).
- `.codeview`, the viewer; wait on it after navigation.
- `#mode-picker` and `#mode-config`, the compare menu and its side pane.
- `button[title="View full file (F)"]` and `button[title="Collapse / expand"]`, header actions. The `Viewed` label and the collapse button sit outside `[data-diffs-header]`, as siblings in one band; index them by file order (the diff list's). Read collapse state from the chevron class: `lucide-chevron-right` collapsed, `lucide-chevron-down` open.
- `aside >> nth=-1`, the threads sidebar (`aside` alone matches the file tree first); `.panel .item`, one thread.
- `file-tree-container` shadow root: `[role="treeitem"][data-item-path]`, one row per file or folder, with the path in `data-item-path`.

### State gotchas

- Review state (viewed, collapsed) persists under the demo repo's `.git/diffle/`. Delete it before a take and assert a clean slate on load; a stale viewed file flips what `v` does.
- Clicking a file header toggles collapse and moves the cursor (`afterCollapse`). Set collapse state first, then place the cursor with keys.
- File order is the tree's order (`pkg/` entries before root files), not flat alphabetical; `gg` lands on the first changed file.

## Prerequisites

Install Playwright once, globally, and fetch its Chromium build. Verify with `playwright --version` and `ffmpeg -hide_banner -encoders | grep libx264`:

```sh
npm install --global playwright
playwright install chromium --only-shell
```

- The harness finds Playwright in the checkout or `npm root -g`; a bare `import 'playwright'` in a scenario does **not** see global installs.
- Chromium needs shared libraries (`libnspr4`, `libnss3`, and friends). `openBrowser()` adds them from `PLAYWRIGHT_LIBS`, or from `~/.pixi/envs/chromelibs/lib` when that env is unset and the directory exists. A machine with neither fails with `cannot open shared object file`.
- The webm to mp4 conversion needs a system `ffmpeg` with `libx264`. Playwright's bundled ffmpeg lacks the encoder.
