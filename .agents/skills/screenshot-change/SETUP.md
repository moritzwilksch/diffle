# Setup

The harness runs from a diffle checkout: it spawns the server with that checkout's `tsx` and serves `dist/client`, so install the project dependencies and build the client first.

```sh
npm install
npm run build:client   # or buildClient() from a scenario
```

The skill carries its own Playwright in `.agents/skills/screenshot-change` so the app's install and CI never pull it. Install it, a browser, and check for a system `ffmpeg` once:

```sh
npm --prefix .agents/skills/screenshot-change install
cd .agents/skills/screenshot-change && npx playwright install chromium --only-shell
ffmpeg -hide_banner -encoders | grep libx264
```

The install also pulls JetBrains Mono and Inter. The harness fronts them in the app's `--mono`/`--sans` tokens, so a host without the design's macOS fonts captures the intended typography instead of DejaVu.

- The harness resolves Playwright from the skill directory first, then the checkout, then `npm root -g`. A bare `import 'playwright'` in a scenario does **not** see any of them; use the harness's `openBrowser()`.
- Chromium needs shared libraries (`libnspr4`, `libnss3`, and friends). `openBrowser()` adds them from `PLAYWRIGHT_LIBS`, or from `~/.pixi/envs/chromelibs/lib` when that env is unset and the directory exists. A machine with neither fails with `cannot open shared object file`.
- The webm to mp4 conversion needs a system `ffmpeg` with `libx264`. Playwright's bundled ffmpeg lacks the encoder.
- `PLAYWRIGHT_MODULE` points at a specific playwright `index.mjs`, for pinning a version.
