// Exercises every harness verb against the current UI. Run it when a verb fails, and after changing
// the markup the verbs rely on (file header, tree rows, composer):
//
//   node .agents/skills/screenshot-change/scripts/shoot.mjs .agents/skills/screenshot-change/scripts/selftest.mjs

export const repo = {
  before: { 'a.py': 'a = 1\nb = 2\nc = 3\n', 'pkg/b.py': 'x = 1\ny = 2\nz = 3\n' },
  after: { 'a.py': 'a = 1\nb = 20\nc = 3\n', 'pkg/b.py': 'x = 1\ny = 20\nz = 3\n' },
};

export default async ({ page, assert, shot, readThreads, ...v }) => {
  assert.deepEqual(await v.filePaths(), ['pkg/b.py', 'a.py']);
  assert.equal(await v.activePath(), 'pkg/b.py');
  await v.gotoFile('a.py');
  assert.equal(await v.activePath(), 'a.py');
  assert.equal(await (await v.header('a.py')).count(), 1);

  assert.equal(await v.collapsed('a.py'), false);
  await v.toggleCollapse('a.py');
  await page.waitForTimeout(300);
  assert.equal(await v.collapsed('a.py'), true);
  // The second toggle finds the button the pointer rests on, whose title the tooltip lifted.
  await v.toggleCollapse('a.py');
  await page.waitForTimeout(300);
  assert.equal(await v.collapsed('a.py'), false);

  await v.setViewed('pkg/b.py', true);
  await page.waitForTimeout(300);
  assert.equal(await v.viewed('pkg/b.py'), true);
  await v.setViewed('pkg/b.py', false);
  await page.waitForTimeout(300);
  assert.equal(await v.viewed('pkg/b.py'), false);

  // Line 2 is the cursor's line after gotoFile: the press must still open the composer.
  await v.gotoFile('a.py');
  await v.selectLines('a.py', 2);
  await page.keyboard.type('Why 20?');
  await shot('composer', page.locator('textarea').first());
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(500);
  const threads = await readThreads();
  assert.deepEqual(
    threads.map((t) => [t.anchor.path, t.anchor.startLine]),
    [['a.py', 2]],
  );

  await page.keyboard.press('Escape');
  const menu = await v.openModePicker();
  assert.equal(await menu.isVisible(), true);
  await page.keyboard.press('Escape');
};
