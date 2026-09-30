# Setup

Playwright is a dev dependency of the checkout; the browser is a separate download. The runner builds the client itself and rebuilds only when its sources change.

```sh
npm ci
npm run test:e2e:install -- --only-shell
ffmpeg -hide_banner -encoders | grep libx264   # video only
```

- Chromium needs shared libraries (`libnspr4`, `libnss3`, and friends). `openBrowser()` adds them from `PLAYWRIGHT_LIBS`, or from `~/.pixi/envs/chromelibs/lib` when that exists; `npm run test:e2e:install-deps` installs them on Debian-like hosts. Without them, launch fails with `cannot open shared object file`.
- Video needs a system `ffmpeg` with `libx264`; Playwright's bundled ffmpeg lacks the encoder.
- `--before` caches built revisions under `<tmpdir>/diffle-base/<sha>`, linked to this checkout's `node_modules`. Delete an entry if its dependencies drifted.
