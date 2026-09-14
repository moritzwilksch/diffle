// Copy this file, point it at a demo repo, and run it with `node`.
//
// The harness lives in this folder; import it by absolute path so the scenario runs from anywhere.
import {
  withDiffle,
  openBrowser,
  newPage,
  crop,
  seedThreads,
  newVideoPage,
  saveVideo,
  viewed,
  collapsed,
  activePath,
  resetReviewState,
} from '/path/to/diffle/.agents/skills/screenshot-change/scripts/harness.mjs';

const REPO = '/tmp/demo';
const OUT = '/tmp/shots';

// Start from clean review state, or a stale viewed/collapsed flag changes the tape.
resetReviewState(REPO);

await withDiffle({ repo: REPO, revs: ['HEAD~1..HEAD'] }, async ({ url }) => {
  await seedThreads(url, [{ path: 'pkg/b.py', startLine: 2, body: 'Why?' }]);
  const browser = await openBrowser();
  try {
    // A still: capture one element once the state is ready.
    const page = await newPage(browser, url);
    await crop(page, 'aside >> nth=-1', `${OUT}/sidebar-after.png`);

    // A video: record the viewport, drive keys, then assert what the tape should show.
    const { page: rec, context, video } = await newVideoPage(browser, url, { dir: OUT });
    await rec.keyboard.press('g');
    await rec.keyboard.press('g');
    await rec.waitForTimeout(600);
    if ((await activePath(rec)) !== 'pkg/b.py') throw new Error('gg should land on b.py');
    await rec.keyboard.press('v');
    await rec.waitForTimeout(600);
    if (!(await viewed(rec, 'pkg/b.py'))) throw new Error('b.py should be viewed');
    if (!(await collapsed(rec, 'pkg/b.py'))) throw new Error('b.py should be collapsed');
    // A comment asserts by its stored path, not by pixels: readThreads(url).some((t) => t.anchor.path === ...)
    await saveVideo(context, video, `${OUT}/video.mp4`);
  } finally {
    await browser.close();
  }
});
