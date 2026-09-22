#!/bin/sh
# The bind mount keeps reports after --rm; return generated files to the host user on Linux.
restore_owner() {
  if [ "${DIFFLE_UID:-0}" != 0 ]; then
    for path in playwright-report test-results test/e2e/__snapshots__; do
      if [ -d "$path" ]; then
        chown -R "$DIFFLE_UID:${DIFFLE_GID:-0}" "$path"
      fi
    done
  fi
}
trap restore_owner EXIT
npm ci && npm run test:e2e -- "$@"
