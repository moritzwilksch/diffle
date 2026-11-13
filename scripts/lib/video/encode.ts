// Capturing and encoding the demo videos' frames.
import type { Page } from '@playwright/test';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, quiet } from '../../../test/e2e/server.js';
import { SLOW } from './pace.js';

export const OUT = join(REPO_ROOT, '.github/assets/videos');
const MP4 = { fps: 30, width: 1920 };
// Legible at GitHub's README width, and still about a megabyte.
const GIF = { fps: 15, width: 1280 };

/** A captured screenshot, and when it was taken in the scene's own (unslowed) seconds. */
export interface Frame {
  file: string;
  at: number;
}

/**
 * Capture screenshots back to back until stopped. Chromium's screencast caps frames at CSS pixels;
 * Playwright's screenshot honours the device scale factor.
 */
export function capture(page: Page, dir: string): () => Promise<Frame[]> {
  const frames: Frame[] = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const file = join(dir, `${String(frames.length).padStart(5, '0')}.jpg`);
      const sent = performance.now();
      await page.screenshot({ path: file, type: 'jpeg', quality: 92, caret: 'initial' });
      frames.push({ file, at: (sent + performance.now()) / 2000 / SLOW });
    }
  })();
  return async () => {
    running = false;
    await loop;
    return frames;
  };
}

/**
 * Encode frames, each shown until the next one arrived and the last held, as `<name>.mp4` with its
 * last frame as a `<name>.webp` poster, and with `gif` also as `<name>.gif`.
 */
export function encode(frames: Frame[], dir: string, name: string, gif: boolean, hold = 1.5) {
  if (frames.length < 2) throw new Error(`${name}: only ${frames.length} frames captured`);
  const lines = frames.flatMap((frame, i) => {
    const next = frames[i + 1];
    return [`file '${frame.file}'`, `duration ${Math.max(next ? next.at - frame.at : hold, 1 / MP4.fps).toFixed(4)}`];
  });
  // The concat demuxer ignores the last entry's duration unless the file is repeated.
  const last = frames.at(-1)!.file;
  lines.push(`file '${last}'`);
  const list = join(dir, 'frames.txt');
  writeFileSync(list, lines.join('\n'));
  const input = ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list];

  const mp4 = join(OUT, `${name}.mp4`);
  const poster = join(OUT, `${name}.webp`);
  quiet('ffmpeg', [
    ...input,
    '-vf',
    `fps=${MP4.fps},scale=${MP4.width}:-2:flags=lanczos`,
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '24',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-an',
    mp4,
  ]);
  quiet('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-i',
    last,
    '-vf',
    `scale=${MP4.width}:-2:flags=lanczos`,
    '-c:v',
    'libwebp',
    '-quality',
    '80',
    poster,
  ]);
  const outputs = [mp4, poster];
  if (gif) {
    const file = join(OUT, `${name}.gif`);
    // One palette for the whole take, and only changed pixels per frame: the UI is mostly still.
    quiet('ffmpeg', [
      ...input,
      '-vf',
      `fps=${GIF.fps},scale=${GIF.width}:-2:flags=lanczos,split[a][b];` +
        '[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle',
      file,
    ]);
    outputs.push(file);
  }
  for (const file of outputs)
    console.log(`${file.slice(REPO_ROOT.length + 1)} ${(statSync(file).size / 1e6).toFixed(1)} MB`);
}
