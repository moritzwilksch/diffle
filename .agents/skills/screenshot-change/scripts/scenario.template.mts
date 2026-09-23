// Copy this file, point it at a demo repo, and run it with `npx tsx <copy>` from the checkout.
//
// The harness is the e2e tests' one: `test/e2e/{server,browser,capture}.ts`. Import it by absolute path so the
// scenario runs from anywhere; `npm run fixture -- <dir>` builds a repo with every diff shape.
import { activePath, collapsed, gotoFile, newPage, openBrowser, viewed } from '/path/to/diffle/test/e2e/browser.ts';
import { crop, newVideoPage, saveVideo } from '/path/to/diffle/test/e2e/capture.ts';
import { resetReviewState, seedThreads, withDiffle } from '/path/to/diffle/test/e2e/server.ts';

const REPO = '/tmp/diffle-fixture';
const OUT = '/tmp/shots';

// Start from clean review state, or a stale viewed/collapsed flag changes the tape.
resetReviewState(REPO);

await withDiffle({ repo: REPO, revs: ['main...feature/refunds'] }, async ({ url }) => {
  await seedThreads(url, [{ path: 'tally/refunds.py', startLine: 2, body: 'Why?' }]);
  const browser = await openBrowser();
  try {
    // A still: capture one element once the state is ready.
    const page = await newPage(browser, url);
    await crop(page, 'aside >> nth=-1', `${OUT}/sidebar-after.png`);

    // A video: record the viewport, drive keys, then assert what the tape should show.
    // Place the cursor before the tape with gotoFile, then let keys carry the beats.
    const { page: rec, context, video } = await newVideoPage(browser, url, { dir: OUT });
    await gotoFile(rec, 'tally/refunds.py');
    await rec.waitForTimeout(600);
    if ((await activePath(rec)) !== 'tally/refunds.py') throw new Error('gotoFile should land on refunds.py');
    await rec.keyboard.press('v');
    await rec.waitForTimeout(600);
    if (!(await viewed(rec, 'tally/refunds.py'))) throw new Error('refunds.py should be viewed');
    if (!(await collapsed(rec, 'tally/refunds.py'))) throw new Error('refunds.py should be collapsed');
    // A comment asserts by its stored path, not by pixels: readThreads(url).some((t) => t.anchor.path === ...)
    await saveVideo(context, video, `${OUT}/video.mp4`);
  } finally {
    await browser.close();
  }
});
