#!/usr/bin/env bash
set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_URL="https://github.com/pavelzw/pixi-browse"
readonly REV="f47af39167ab6750ae558106d3b19536963ae747"
readonly OUTPUT_DIR="$ROOT/.github/assets"
readonly FINDING='{"path":"pixi_browse/tui/app.py","startLine":157,"body":"Could this be immutable? I only see the whole value being replaced."}'

cd "$ROOT"
command -v pyrefly >/dev/null || { echo "pyrefly is required to create the screenshots." >&2; exit 1; }

playwright_bin="${PLAYWRIGHT_BIN:-$(command -v playwright || true)}"
if [[ -z "$playwright_bin" ]]; then
  cat >&2 <<'EOF'
Playwright is required to create the screenshots. Install it with:

  npm install --global playwright
  playwright install chromium --only-shell
EOF
  exit 1
fi
playwright_module="$(node - "$playwright_bin" <<'EOF'
const { dirname, join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { realpathSync } = require('node:fs');
process.stdout.write(pathToFileURL(join(dirname(realpathSync(process.argv[2])), 'index.mjs')).href);
EOF
)"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/diffle-screenshots.XXXXXX")"
diffle_pid=""

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$diffle_pid" ]] && kill -0 "$diffle_pid" 2>/dev/null; then
    kill -TERM "$diffle_pid" 2>/dev/null || true
    for _ in {1..50}; do
      kill -0 "$diffle_pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL "$diffle_pid" 2>/dev/null || true
    wait "$diffle_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp"
  exit "$status"
}
trap cleanup EXIT INT TERM

checkout="$tmp/pixi-browse"
stdout_log="$tmp/diffle.stdout"
stderr_log="$tmp/diffle.stderr"

git init --quiet "$checkout"
git -C "$checkout" remote add origin "$REPO_URL"
git -C "$checkout" fetch --quiet --depth=6 --filter=blob:none origin "$REV"
git -C "$checkout" checkout --quiet --detach FETCH_HEAD

mkdir -p "$OUTPUT_DIR"

NO_COLOR=1 "$ROOT/node_modules/.bin/tsx" "$ROOT/src/cli/main.ts" \
  -C "$checkout" \
  --port 0 \
  --no-open \
  --no-watch \
  --lsp \
  HEAD~5...HEAD \
  >"$stdout_log" 2>"$stderr_log" &
diffle_pid=$!

url=""
for _ in {1..100}; do
  url="$(awk '/diffle running at/{print $NF; exit}' "$stderr_log")"
  [[ -n "$url" ]] && break
  if ! kill -0 "$diffle_pid" 2>/dev/null; then
    cat "$stderr_log" >&2
    exit 1
  fi
  sleep 0.1
done

if [[ -z "$url" ]]; then
  echo "Timed out waiting for diffle to start." >&2
  cat "$stderr_log" >&2
  exit 1
fi

# The screenshot needs a comment on screen; the server has no other way in.
SEED_URL="$url" SEED_BODY="$FINDING" node --input-type=module <<'EOF'
const res = await fetch(new URL('api/threads', process.env.SEED_URL), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: process.env.SEED_BODY,
});
if (!res.ok) {
  console.error(`seeding the screenshot comment failed: HTTP ${res.status} ${await res.text()}`);
  process.exit(1);
}
EOF

PLAYWRIGHT_MODULE="$playwright_module" SCREENSHOT_URL="$url" SCREENSHOT_OUTPUT_DIR="$OUTPUT_DIR" node --input-type=module <<'EOF'
import { join } from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const browser = await chromium.launch();
try {
  for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({
      colorScheme,
      deviceScaleFactor: 1,
      viewport: { width: 1920, height: 1080 },
    });
    const page = await context.newPage();
    await page.goto(process.env.SCREENSHOT_URL);
    const thread = page.locator('.panel .item').first();
    await thread.waitFor();
    await thread.click();
    await page.locator('.comment-card.focused').waitFor();
    await page.waitForTimeout(750);
    // Shiki merges adjacent tokens that share a colour, so the symbol may sit in a span with its
    // trailing punctuation. Match the start of the token; the click still lands inside the word.
    await page.locator('span[data-char]', { hasText: /^VersionDataLoader\b/ }).first().click();
    await page.locator('.symbol-menu').waitFor();
    await page.waitForTimeout(750);
    await page.screenshot({
      animations: 'disabled',
      path: join(process.env.SCREENSHOT_OUTPUT_DIR, `diffle-${colorScheme}.png`),
    });
    await context.close();
  }
} finally {
  await browser.close();
}
EOF

echo "Wrote .github/assets/diffle-light.png"
echo "Wrote .github/assets/diffle-dark.png"
