# Setup

```sh
npm ci
npm run test:e2e:install -- --only-shell
ffmpeg -hide_banner -encoders | grep -E 'libwebp |libvpx-vp9'
```

- **ffmpeg:** a system build with `libwebp` (stills) and `libvpx-vp9` (video). Playwright's bundled ffmpeg has neither.
- **Chromium libraries:** launch fails with `cannot open shared object file` without `libnspr4`, `libnss3`, and friends. `openBrowser()` loads them from `PLAYWRIGHT_LIBS`, or `~/.pixi/envs/chromelibs/lib` when it exists; `npm run test:e2e:install-deps` installs them on Debian-like hosts.
- **`--before` cache:** built revisions live under `<tmpdir>/diffle-base/<sha>`, linked to this checkout's `node_modules`. Delete an entry whose dependencies drifted.
