# Setup

The harness is `test/e2e/harness.ts`, the one the e2e tests run on. It spawns the server with the checkout's `tsx` and serves `dist/client`, so install the project dependencies and build the client first. Playwright and the design fonts are dev dependencies of the checkout; only the browser is a separate download.

```sh
npm install
npx playwright install chromium --only-shell
npm run build:client   # or buildClient() from a scenario
ffmpeg -hide_banner -encoders | grep libx264   # video only
```

- A scenario is TypeScript run with `npx tsx <file>` from the checkout, so it can import the harness directly.
- The harness fronts JetBrains Mono and Inter in the app's `--mono`/`--sans` tokens, so a host without the design's macOS fonts captures the intended typography instead of DejaVu.
- Chromium needs shared libraries (`libnspr4`, `libnss3`, and friends). `openBrowser()` adds them from `PLAYWRIGHT_LIBS`, or from `~/.pixi/envs/chromelibs/lib` when that env is unset and the directory exists. A machine with neither fails with `cannot open shared object file`; `npx playwright install-deps chromium` installs them on Debian-like hosts.
- The webm to mp4 conversion needs a system `ffmpeg` with `libx264`. Playwright's bundled ffmpeg lacks the encoder.
- `npm run fixture -- <dir>` builds a repository with every diff shape, checked out with uncommitted changes; use it instead of hand-rolling a demo repo.
