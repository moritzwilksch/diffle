// The demo videos' scenes. Each gets a fresh repository and a fresh diffle, so no review state
// carries over.
import type { Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readThreads, runCli } from '../../../test/e2e/server.js';
import { OUT } from './encode.js';
import {
  SLOW,
  VIEWPORT,
  activePath,
  clickOn,
  comment,
  glide,
  hoverUntil,
  hoverWord,
  lineOf,
  pause,
  pickFromSymbolMenu,
  selectLines,
  stepToReference,
  walkTo,
  wordBox,
} from './pace.js';
import { tour } from './tour.js';

// Pinned, so hover text and reference lists read the same on every machine.
export const PYTHON_LSP = process.env.PYTHON_LSP ?? 'pixi exec --spec pyrefly==1.3.2 pyrefly lsp';

export interface Scene {
  play(page: Page, demo: { url: string; repo: string }): Promise<void>;
  /** Further diffle flags; no language server unless the scene shows one. */
  args?: string[];
  /** Unified leaves the comment composer room; the rest use split. */
  unified?: boolean;
  /** Also cut a README GIF from the take. */
  gif?: boolean;
}

export const SCENES: Record<string, Scene> = {
  /**
   * The core loop with a language server: hover a call, find its references, jump to one, comment on
   * it, read the agent's reply, and copy every comment as one prompt.
   */
  review: {
    args: ['--lsp', `python=${PYTHON_LSP}`],
    unified: true,
    gif: true,
    async play(page, { url, repo }) {
      await pause(page, 1000);
      await walkTo(page, 'shortlink/app.py');
      await hoverUntil(page, 'shortlink/app.py', 'allow', 'Spend one token');
      await pause(page, 2400);

      const call = await wordBox(page, 'shortlink/app.py', 'allow');
      await page.mouse.click(call.x + 6, call.y + call.height / 2);
      await pickFromSymbolMenu(page, 'Find references');
      await page.getByRole('dialog').waitFor();
      await pause(page, 1200);
      const test = 'tests/test_ratelimit.py';
      const refill = lineOf(repo, test, 'now[0] += 0.5');
      await stepToReference(page, test, refill + 1);
      await pause(page, 600);
      await page.keyboard.press('Enter');
      await pause(page, 1500);

      await selectLines(page, test, refill, refill + 1);
      await comment(page, 'Why 0.5 s? Is that just enough for the next call to pass?');

      // A question, since an answer to a change request would have to change the diff too. The agent
      // answers through the real CLI, as it would beside the review; the reply arrives live.
      await glide(page, VIEWPORT.width * 0.55, VIEWPORT.height * 0.3);
      await pause(page, 1200);
      const [thread] = await readThreads(url);
      const reply =
        'Yes: at `rate=2.0` one token takes 0.5 s to refill, so this is the shortest wait that lets the next call through.';
      await runCli(['comments', 'reply', thread!.id, reply, '-C', repo]);
      await page.getByText('the shortest wait').first().waitFor();
      await pause(page, 2800);

      await page.keyboard.press('y');
      await pause(page, 90);
      await page.keyboard.press('y');
      // End while the copy-all button still shows its check mark, so the poster shows the copy landed.
      await pause(page, 1000);

      const prompt = await (await fetch(new URL('api/threads/export?state=open', url))).text();
      writeFileSync(join(OUT, 'prompt.md'), prompt);
    },
  },

  /** Keyboard-first reading: lines, hunks, files, viewed marks, the range's commits, the file filter. */
  navigate: {
    async play(page) {
      await pause(page, 1000);
      for (let i = 0; i < 5; i++) {
        await page.keyboard.press('j');
        await pause(page, 170);
      }
      await pause(page, 300);
      await page.keyboard.press('v');
      await pause(page, 1200);
      for (const key of [']', ']', ']']) {
        await page.keyboard.press(key);
        await pause(page, 700);
      }
      await page.keyboard.press('K');
      await pause(page, 900);
      await page.keyboard.press('J');
      await pause(page, 900);
      // Step from the whole range through each commit, oldest last, then back up to all changes.
      for (const key of ['<', '<', '<', '>', '>', '>']) {
        await page.keyboard.press(key);
        await pause(page, 1000);
      }
      await page.keyboard.press('g');
      await pause(page, 80);
      await page.keyboard.press('f');
      await pause(page, 400);
      await page.keyboard.type('test', { delay: 120 * SLOW });
      await pause(page, 900);
      await page.keyboard.press('Enter');
      await pause(page, 1500);
      await page.keyboard.press('?');
      await pause(page, 2600);
    },
  },

  /** Language-server hover, go to definition, and references, served by a pinned pyrefly. */
  lsp: {
    args: ['--lsp', `python=${PYTHON_LSP}`],
    async play(page) {
      await pause(page, 900);
      await hoverUntil(page, 'shortlink/app.py', 'allow', 'Spend one token');
      await pause(page, 2600);

      const call = await wordBox(page, 'shortlink/app.py', 'allow');
      await page.mouse.click(call.x + 6, call.y + call.height / 2);
      await pickFromSymbolMenu(page, 'Go to definition');
      for (let i = 0; i < 50 && (await activePath(page)) !== 'shortlink/ratelimit.py'; i++) await pause(page, 50);
      await pause(page, 1500);

      const definition = await hoverWord(page, 'shortlink/ratelimit.py', 'allow');
      await pause(page, 500);
      await page.mouse.click(definition.x + 6, definition.y + definition.height / 2);
      await pickFromSymbolMenu(page, 'Find references');
      await pause(page, 1800);
      // Peek at the highlighted reference, walk the list down to a call in the tests, and jump there.
      await page.keyboard.press(' ');
      // The hint gains `J K scroll` once the peek is open.
      await page.getByRole('dialog').getByText('scroll').waitFor();
      await pause(page, 1600);
      for (let i = 0; i < 4; i++) {
        await page.keyboard.press('j');
        await pause(page, 900);
      }
      await pause(page, 600);
      await page.keyboard.press('Enter');
      await pause(page, 2200);
    },
  },

  /** The change graph: files, then symbols, a node's links in the panel, a peek at them, a pan to another node. */
  graph: {
    args: ['--lsp', `python=${PYTHON_LSP}`],
    gif: true,
    async play(page) {
      await pause(page, 900);
      await page.keyboard.press('M');
      const graph = page.getByRole('img', { name: 'Change graph' });
      await graph.locator('[data-node]').first().waitFor({ timeout: 30000 });
      await pause(page, 2000);
      await clickOn(page, page.getByRole('button', { name: 'Symbols' }));
      await pause(page, 2000);

      // `shorten` in app.py uses the limiter, its retry hint and the store.
      const node = (id: string) => graph.locator(`[data-node=${JSON.stringify(id)}]`);
      await clickOn(page, node('shortlink/app.py:18:10'));
      await pause(page, 1800);
      const panel = page.locator('aside').last();
      const box = (await panel.boundingBox())!;
      await glide(page, box.x + box.width / 2, box.y + box.height * 0.6, 20);
      for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(0, 120);
        await pause(page, 220);
      }
      await pause(page, 1200);

      await clickOn(page, panel.getByRole('button', { name: 'Peek' }).first());
      const list = page.getByRole('dialog', { name: 'References' });
      await list.waitFor();
      await pause(page, 1200);
      await page.keyboard.press(' ');
      await list.getByRole('region', { name: 'Peek' }).waitFor();
      await pause(page, 1400);
      for (let i = 0; i < 2; i++) {
        await page.keyboard.press('j');
        await pause(page, 1100);
      }
      await page.keyboard.press('Escape');
      await pause(page, 300);
      await page.keyboard.press('Escape');
      await list.waitFor({ state: 'hidden' });
      await pause(page, 900);

      // A card in the panel frames its node; a double-click frames one in the graph.
      await clickOn(page, panel.getByRole('listitem').first());
      await pause(page, 2000);
      const bucket = (await node('shortlink/ratelimit.py:6:6').boundingBox())!;
      await glide(page, bucket.x + bucket.width / 2, bucket.y + bucket.height / 2);
      await pause(page, 250);
      await page.mouse.dblclick(bucket.x + bucket.width / 2, bucket.y + bucket.height / 2);
      await pause(page, 2400);
    },
  },

  /** An agent's tour of the change: its diagram and walk stepped, a symbol looked up, a comment, a checklist answered. */
  tour: {
    args: ['--lsp', `python=${PYTHON_LSP}`],
    gif: true,
    play: (page, { url }) => tour(page, url),
  },

  /** Search across every changed file. */
  search: {
    async play(page) {
      await pause(page, 1000);
      await page.keyboard.press('g');
      await pause(page, 80);
      await page.keyboard.press('/');
      await pause(page, 500);
      await page.keyboard.type('limiter', { delay: 110 * SLOW });
      await pause(page, 400);
      await page.keyboard.press('Enter');
      await pause(page, 1100);
      // Step past the matches in app.py into the limiter itself and its tests.
      for (const wait of [500, 500, 500, 500, 500, 900, 900, 900, 1100]) {
        await page.keyboard.press('n');
        await pause(page, wait);
      }
      await pause(page, 800);
    },
  },
};
