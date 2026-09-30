# Setup

Install once per checkout. The runner builds the client itself and rebuilds only when its sources change.

```sh
npm install
npm --prefix .agents/skills/screenshot-change install
(cd .agents/skills/screenshot-change && npx playwright install chromium --only-shell)
ffmpeg -hide_banner -encoders | grep libx264   # video only
```

The skill carries its own Playwright so the app's install and CI never pull it.

- The harness resolves Playwright from the skill directory, then the checkout, then `npm root -g`; `PLAYWRIGHT_MODULE` pins a specific `index.mjs`. A bare `import 'playwright'` in a scenario sees none of them; use `h.openBrowser()`.
- Chromium needs shared libraries (`libnspr4`, `libnss3`, and friends). `openBrowser()` adds them from `PLAYWRIGHT_LIBS`, or from `~/.pixi/envs/chromelibs/lib` when that exists. Without either, launch fails with `cannot open shared object file`.
- Video needs a system `ffmpeg` with `libx264`; Playwright's bundled ffmpeg lacks the encoder.
- `--before` caches built base revisions under `<tmpdir>/diffle-shoot-base/<sha>`, linked to this checkout's `node_modules`. Delete an entry if its dependencies drifted.
