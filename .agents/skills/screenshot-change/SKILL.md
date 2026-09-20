---
name: screenshot-change
description: Capture cropped before/after screenshots or record a video of diffle UI changes. Use when asked to screenshot or record the UI, or to demonstrate a client change visually.
---

# Capture a diffle UI change

Prove each change with the smallest image that shows it. A capture is a short scenario script over `scripts/harness.mjs`; copy `scripts/scenario.template.mjs` and edit it. The harness documents the rest.

## Screenshots

1. **Prepare a throwaway repo with a diff.** Keep it outside the checkout and pass it with `-C`. Include the lines and files the change touches; content only needs to render. Done when `git -C <repo> diff <range>` lists the changed files.
2. **Build the client once.** `buildClient()` (install dependencies first, see [SETUP.md](SETUP.md)). The server serves `dist/client`; server code rarely affects a capture.
3. **Capture the after state.** Crop to the element with `crop(page, selector, path)`, or `clip(page, box, path)` for a region. Seed what the server can hold with `seedThreads(url, threads)`; drive what has no endpoint with the page. Reach diffle controls through the verbs (`header`, `viewed`, `collapsed`, `setViewed`, `toggleCollapse`) instead of locators. Done when every change has a named crop.
4. **Capture the before state** inside `withBaseClient(rev, fn)`. It builds `rev` into a worktree, installs that client, runs `fn`, then restores this checkout's client. Re-run the same scenario inside `fn`. Done when each after crop has a before crop from the same selector.
5. **Verify** by reading one crop per change. Done when the pixels show the stated difference; re-capture rather than describe a mismatch.

## Video

Record behavior that unfolds over time: key presses, cursor jumps, collapses. Steps 1 and 2 are the screenshot workflow's.

1. **Record the run.** `newVideoPage(browser, url, { dir })` records at the viewport size, so frames map 1:1 to CSS pixels. Drive it with `page.keyboard`, pausing between beats so a reader can follow. The vim keys are document-level: `gg` first file, `J`/`K` move file, `v` toggle viewed, `zc` collapse; use them for the beats a viewer should follow. Set up before recording with `gotoFile(page, path)`, which clicks the tree row and waits for the cursor, instead of counting `J` presses. Keyboard selection beats `selectLines` here: `V` starts it, `j` extends, `c` opens the composer, so the comment lands in the file under the cursor.
2. **Assert while recording.** A recording that asserts is a test; one that only shows is a hope. Assert the controls with the verbs (`activePath` after each `J`/`K`), and assert the setup too; stale state silently changes what the run means. Assert a submitted comment with `readThreads(url)` and its `anchor.path`, not just the pixels.
3. **Save and verify.** `saveVideo(context, video, path)` closes the context, converts the recorded webm to mp4, and writes it to `path`. It leaves the intermediate webm next to the mp4; delete it if the take is good. Recording starts when the context opens, before the page settles, so wall-clock beats drift from video time. Read frames back with `frame(mp4, seconds, png)` and size the beats with `videoDuration(mp4)` rather than trusting a stopwatch. Done when the transition is on tape; re-record rather than describe a mismatch.

## Notes

- **Crop to the element.** Read back only the crops: a 500×200 crop costs a fraction of a 1440×900 frame. Captures are 2x by default (`newPage(..., { scale })`), so a crop's pixel count is four times its CSS box.
- **The app sets the type.** The client bundles JetBrains Mono and Inter, and `newPage`/`newVideoPage` wait for `document.fonts.ready`, so a capture on any host shows the design's fonts.
- **Seed over HTTP.** Clicking state through the UI is slower and flakier than one request.
- **Wait on a signal.** `locator.waitFor()` beats `waitForTimeout`; keep timeouts for animations only.
- **Locators pierce the shadow DOM, `page.evaluate` does not.** The viewer and file tree render into shadow roots, so reach for Playwright locators (or the verbs) instead of `querySelector` inside `evaluate`.
- **Viewing moves the cursor.** `setViewed` and `v` collapse the file and land on the next unviewed file, so read `activePath` after them. `setViewed` clicks the checkbox and blurs it so later keys still land; a raw checkbox click would leave focus on the `INPUT` and swallow the keymap.
- Diffle verbs index files by tree order (`pkg/` before root files), not flat alphabetical, so pass the exact changed path. `gotoFile(page, path)` moves the cursor there deterministically; `filePaths(page)` returns the order when you need it. These read the file tree, so they need it visible (`Ctrl+B` toggles it).
- Review state (viewed, collapsed, threads) persists under the demo repo's `<git-dir>/diffle/`; call `resetReviewState(repo)` before a take so the run starts clean.
- `selectLines(page, path, from, to)` selects a line range in one file and opens the composer; `openModePicker` opens the compare menu. Line numbers repeat across files, so always pass the path the cursor is in.
- Read state back with `readThreads(url)` and `activePath(page)` instead of scraping the DOM. A thread's path is `anchor.path`, not a top-level `path`.
- A launch failure means missing setup: see [SETUP.md](SETUP.md).
