# Setup

```sh
npm ci
ffmpeg -hide_banner -encoders | grep -E 'libwebp |libvpx-vp9'
```

- **ffmpeg:** a system build with `libwebp` (stills) and `libvpx-vp9` (video). Playwright's bundled ffmpeg has neither.
- **Docker:** the browser is Playwright's Linux Chromium in a container (`compose.yml`); `openBrowser()` starts it and stops it again when the browser closes. `DIFFLE_BROWSER_WS` names a server running elsewhere.
- **`--before` cache:** built revisions live under `<tmpdir>/diffle-base/<sha>`, linked to this checkout's `node_modules`. Delete an entry whose dependencies drifted.
