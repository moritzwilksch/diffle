# Setup

The harness runs from a diffle checkout: it spawns the server with that checkout's `tsx` and serves `dist/client`, so install the project dependencies and build the client first.

```sh
npm install
npm run build:client   # or buildClient() from a scenario
```

Playwright is a devDependency (the `npm install` above), and it needs a browser and a system `ffmpeg`. Install the browser once:

```sh
npx playwright install chromium --only-shell
```

Verify with `npx playwright --version` and `ffmpeg -hide_banner -encoders | grep libx264`.

- The harness finds Playwright in the checkout first, then `npm root -g`; a bare `import 'playwright'` in a scenario does **not** see either. Use the harness's `openBrowser()`.
- Chromium needs shared libraries (`libnspr4`, `libnss3`, and friends). `openBrowser()` adds them from `PLAYWRIGHT_LIBS`, or from `~/.pixi/envs/chromelibs/lib` when that env is unset and the directory exists. A machine with neither fails with `cannot open shared object file`.
- The webm to mp4 conversion needs a system `ffmpeg` with `libx264`. Playwright's bundled ffmpeg lacks the encoder.
- `PLAYWRIGHT_MODULE` points at a specific playwright `index.mjs`, for pinning a version.
