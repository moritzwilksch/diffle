# Setup

The shared helpers live in `test/e2e/`: `server.ts` starts diffle and builds the client, `browser.ts` drives the review UI, and `capture.ts` records video and swaps before/after client builds. The server uses the checkout's `tsx` and serves `dist/client`, so install the project dependencies and build the client first. Playwright is a dev dependency of the checkout; only the browser is a separate download.

```sh
npm install
npx playwright install chromium --only-shell
npm run build:client   # or buildClient() from a scenario
ffmpeg -hide_banner -encoders | grep libx264   # video only
```

- A scenario is TypeScript run with `npx tsx <file>` from the checkout, so it can import the harness directly.
- Chromium needs shared libraries (`libnspr4`, `libnss3`, and friends). `openBrowser()` adds them from `PLAYWRIGHT_LIBS`, or from `~/.pixi/envs/chromelibs/lib` when that env is unset and the directory exists. A machine with neither fails with `cannot open shared object file`; `npx playwright install-deps chromium` installs them on Debian-like hosts.
- The webm to mp4 conversion needs a system `ffmpeg` with `libx264`. Playwright's bundled ffmpeg lacks the encoder.
- `npm run fixture -- <dir>` builds a repository with every diff shape, checked out with uncommitted changes; use it instead of hand-rolling a demo repo.
