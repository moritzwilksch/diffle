---
name: screenshot-change
description: Capture cropped before/after screenshots or record a video of diffle UI changes. Use when asked to screenshot or record the UI, or to demonstrate a client change visually.
---

# Capture a diffle UI change

Prove each change with the smallest image that shows it: write a scenario, run it, read the one image it points at. Setup: [SETUP.md](SETUP.md).

A change that should stay proven belongs in `test/e2e/*.spec.ts` with `toHaveScreenshot` instead; `npm run test:e2e:docker:update` accepts its screenshots, and the PR's snapshot report shows them to reviewers.

## Write a scenario

Save it in your scratch directory, never in the checkout:

```ts
import type { ScenarioContext } from '<checkout>/scripts/screenshot.ts';

export default async ({ page, shot, selectLines }: ScenarioContext) => {
  await selectLines('tally/ledger.py', 3, 3);
  await page.keyboard.type('Wait...');
  await shot('composer', page.getByPlaceholder('Leave a comment…'));
};
```

Optional exports (`Scenario` in `scripts/screenshot.ts`):

- `repo`: the fixture repository by default (`test/fixture/repo.ts` describes its files; `npm run fixture` prints its comparisons); `{ before, after, commit? }` files for a diff it lacks; or an absolute repo path.
- `revs`: the fixture's `main...feature/refunds`, `HEAD~1..HEAD` for a committed demo, else none.
- `args`: extra diffle flags; `['--lsp']` starts language servers (then `waitForLsp()`, `hoverSymbol(text)`).
- `setup({ url, seedThreads })`: runs before the page opens; seed server state here.
- `viewport`: `{ width, height, colorScheme, scale }`, default 1440×900, light, 2x.
- `video`: `true` records each side to `<scenario>-<side>.mp4` at 1x.

The default export receives `page`, `side`, `assert` (`node:assert/strict`), `shot(label, selector | locator | box)`, `seedThreads`, `readThreads`, `readPrompt`, `waitForLsp`, and every verb in `test/e2e/browser.ts` bound to the page: `filePaths`, `activePath`, `gotoFile`, `walkToFile`, `header`, `viewed`, `setViewed`, `collapsed`, `toggleCollapse`, `selectLines`, `clickLine`, `hoverSymbol`, `waitForHighlight`, `openModePicker`. Verbs take the changed file's exact path, bring an off-screen file into view themselves, and fail with the reason when a file has no lines or a line is outside the diff.

## Run it

```sh
npm run screenshot -- <scenario.ts> --before origin/main --out <scratch>/shots
```

The runner builds what is stale and runs the scenario against this checkout and, with `--before`, against that revision's own server and client (cached per commit). It prints only paths: each `<label>-<side>.png` and a labelled `<label>-compare.png`. Read the compare image; attach the per-side crops to the PR. A failure prints the error, the scenario line, and `failure-<side>.png`, and exits 1.

## Rules

- **Assert, don't hope.** Check state with the verbs and `readThreads()`, not pixels. A thread's path is `anchor.path` and its text `messages[0].body`; scenarios run untyped, so check `CommentThread` in `src/shared/protocol.ts`. For video, assert after each beat: `J`/`K` move file (the first `J` lands on the first file), `v` views, `zc` collapses, `V`…`c` comments.
- **Wait on signals.** Prefer `locator.waitFor()` and `expect.poll`; keep `waitForTimeout` for animations and video beats.
- **Locators pierce shadow DOM; `page.evaluate` does not.** The viewer and tree render in shadow roots.
- **Mind the cursor and focus.** Verbs move the cursor to the file they act on, and viewing moves it to the next unviewed file. A focused `INPUT` swallows the keymap; `setViewed` blurs its checkbox.
- **A verb that fails on current UI means the markup moved.** Fix `test/e2e/browser.ts` until `npx playwright test test/e2e/harness.spec.ts` passes, and ship the fix with your change.
