---
name: record-screen
description: Capture before/after screenshots or a video of a diffle UI change and attach them to a PR. Use when asked to screenshot, record, or visually demonstrate a client change.
---

# Record a diffle UI change

Show each change with the smallest capture that proves it: write a scenario, run it, read the one image it points at, attach the outputs. First run on a host: [SETUP.md](SETUP.md).

A change that should stay proven belongs in `test/e2e/*.spec.ts` with `toHaveScreenshot` instead.

## Write a scenario

Save it in your scratch directory, outside the checkout:

```ts
import type { ScenarioContext } from '<checkout>/scripts/screenshot.ts';

export default async ({ page, shot, selectLines }: ScenarioContext) => {
  await selectLines('tally/ledger.py', 3, 3);
  await page.keyboard.type('Wait...');
  await shot('composer', page.getByPlaceholder('Leave a comment…'));
};
```

`Scenario` and `ScenarioContext` in `scripts/screenshot.ts` list every option and helper. The ones to know:

- `export const video = true` records each side to `<scenario>-<side>.webm` at 1x instead of taking stills.
- `repo` defaults to the fixture repository (`test/fixture/repo.ts`); pass `{ before, after }` files for a diff it lacks.
- `args = ['--lsp']` starts language servers; then call `waitForLsp()` before `hoverSymbol(text)`.
- `setup({ url, seedThreads })` seeds server state before the page opens.
- The page verbs come from `test/e2e/browser.ts`. They take the changed file's exact path and scroll it into view.

## Run it

```sh
npm run screenshot -- <scenario.ts> --before origin/main --out <out>
```

It prints only paths: `<label>-<side>.webp` per `shot`, a labelled `<label>-compare.webp` per pair, and `<scenario>-<side>.webm` per video. Read the compare image to verify. A failure prints the error, the scenario line, and `failure-<side>.png`, and exits 1.

## Attach to the PR

Always upload captures with `--attach` on `gh pr create`, `gh pr edit`, or `gh pr comment`. GitHub then hosts them as user attachments, outside the repository.

In the body, reference each file by the path you pass to `--attach`. gh matches the two by absolute path, so keep `<out>` absolute and gh runs from any directory; it rewrites each reference to the uploaded URL:

```md
![Composer before](<out>/composer-before.webp) ![Composer after](<out>/composer-after.webp)

![](<out>/demo-after.webm)
```

```sh
gh pr edit <number> --body-file body.md \
  --attach <out>/composer-before.webp --attach <out>/composer-after.webp --attach <out>/demo-after.webm
```

- **Video:** write `![](path.webm)` alone in its paragraph; gh turns it into the bare URL GitHub renders as a player. Anywhere else, or as `[text](path)`, it becomes a plain link.
- **Image:** `![alt](path)` works anywhere; the body's alt text wins over `--attach 'path#alt'`.
- **Body:** `--body-file` replaces the whole description, so `body.md` holds all of it. Files the body never references are appended at the end.

## Rules

- **Assert, don't hope.** Check state with the verbs and `readThreads()`, not pixels. A thread's path is `anchor.path`, its text `messages[0].body`; see `CommentThread` in `src/shared/protocol.ts`. In a video, assert after each beat: `J`/`K` move between files (the first `J` lands on the first file), `v` views, `zc` collapses, `V`…`c` comments.
- **Wait on signals.** Use `locator.waitFor()` and `expect.poll`; reserve `waitForTimeout` for animations and video pacing.
- **Locators pierce shadow DOM; `page.evaluate` does not.** The viewer and tree render in shadow roots.
- **Track cursor and focus.** Verbs move the cursor to their file; viewing a file moves it to the next unviewed one. A focused `INPUT` takes keystrokes the keymap would handle; `setViewed` blurs its checkbox.
- **Crop small.** WebP caps each side at 16383 px, and a tight crop is cheaper to read.
- **A verb failing on current UI means the markup moved.** Fix `test/e2e/browser.ts` until `npx playwright test test/e2e/harness.spec.ts` passes, and ship the fix with your change.
