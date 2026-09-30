---
name: screenshot-change
description: Capture cropped before/after screenshots or record a video of diffle UI changes. Use when asked to screenshot or record the UI, or to demonstrate a client change visually.
---

# Capture a diffle UI change

Prove each change with the smallest image that shows it. Write a scenario, run it with `scripts/shoot.mjs`, read the one image it points at. Setup: [SETUP.md](SETUP.md).

## Write a scenario

Save it in your scratch directory, never in the checkout:

```js
// Demo repo: `before` committed, `after` committed on top (null deletes a file).
export const repo = { before: { 'a.py': 'x = 1\n' }, after: { 'a.py': 'x = 2\n' } };

export default async ({ page, shot, selectLines }) => {
  await selectLines('a.py', 1);
  await page.keyboard.type('Wait...');
  await shot('composer', page.locator('textarea').first());
};
```

Exports:

- `repo`: `{ before, after, commit? }` files for a fresh demo repo (`commit: false` leaves `after` uncommitted), or the absolute path of an existing repo.
- `revs`: diffle's revision arguments. Default `HEAD~1..HEAD` for a committed demo, none (the working tree) otherwise.
- `args`: extra diffle flags, e.g. `['--context', '10']`.
- `setup({ url, seedThreads })`: runs before the page opens; seed server state here.
- `viewport`: `{ width, height, colorScheme, scale }`, default 1440×900, light, 2x.
- `video`: `true` records each side to `<scenario>-<side>.mp4` at 1x.
- `default(ctx)`: the interaction. `ctx` holds `page`, `url`, `side`, `assert` (`node:assert/strict`), `h` (the whole harness), `shot`, `seedThreads`, `readThreads`, and the verbs bound to the page.

`shot(label, target)` crops a selector or locator, or clips a `{ x, y, width, height }` box, to `<label>-<side>.png`.

Verbs, which take the changed file's exact path:

| Verb                                       | Does                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------- |
| `filePaths()`                              | Changed files in tree order (`pkg/` before root files).                         |
| `activePath()`                             | File under the cursor.                                                          |
| `gotoFile(path)`                           | Moves the cursor there via the tree.                                            |
| `header(path)`                             | The file header locator.                                                        |
| `viewed(path)` / `setViewed(path, on)`     | Viewed state. Viewing collapses and moves the cursor to the next unviewed file. |
| `collapsed(path)` / `toggleCollapse(path)` | Collapse state.                                                                 |
| `selectLines(path, from, to?, side?)`      | Drags the number column and waits for the composer. Presses Escape first.       |
| `openModePicker(entry?)`                   | Opens the compare menu, optionally picks an entry.                              |

## Run it

```sh
node .agents/skills/screenshot-change/scripts/shoot.mjs <scenario.mjs> --before origin/main --out <scratch>/shots
```

It builds what is stale, runs the scenario against this checkout and, with `--before`, against the base revision's own server and client. It prints the output paths only: each shot per side and a labelled `<label>-compare.png`. Read the compare image; attach the per-side crops to the PR. A failure prints the error, the scenario line, and `failure-<side>.png` of the viewport; exit status 1.

## Rules

- **Assert, don't hope.** Check state with the verbs and `readThreads()` (a thread's path is `anchor.path`), not pixels. For video, assert after each beat: `J`/`K` move file (the first `J` lands on the first file), `v` views, `zc` collapses, `V`…`c` comments.
- **Wait on signals.** Prefer `locator.waitFor()`; keep `waitForTimeout` for animations and video beats.
- **Locators pierce shadow DOM; `page.evaluate` does not.** The viewer and tree render in shadow roots.
- **The verbs park the pointer** at the top-left corner, because the app's tooltip lifts `title` off a hovered control. Hover again before a shot of a hover state.
- **Focus matters.** A focused `INPUT` swallows the keymap; `setViewed` blurs its checkbox, and raw clicks should too.
- **A verb that times out means the UI moved.** Run `scripts/selftest.mjs` through `shoot.mjs`, fix `harness.mjs` until it passes, and ship the fix with your change.
