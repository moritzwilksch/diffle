#!/bin/sh
# Installs the diffle binary from a GitHub release.
#   curl -fsSL https://github.com/moritzwilksch/diffle/releases/latest/download/install.sh | sh
# DIFFLE_VERSION picks a release tag (default: latest); DIFFLE_INSTALL_DIR the target (default: ~/.local/bin);
# DIFFLE_DOWNLOAD_URL a mirror of the release assets.
set -eu

repo=moritzwilksch/diffle
version=${DIFFLE_VERSION:-latest}
dir=${DIFFLE_INSTALL_DIR:-$HOME/.local/bin}

fail() {
  echo "diffle install: $*" >&2
  exit 1
}

case $(uname -s) in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  MINGW* | MSYS* | CYGWIN*) fail "on Windows, download diffle-windows-<arch>.zip from https://github.com/$repo/releases" ;;
  *) fail "no binary for $(uname -s); install with npm or pixi instead" ;;
esac

case $(uname -m) in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) fail "no binary for $(uname -m); install with npm or pixi instead" ;;
esac

# A shell under Rosetta reports x86_64 on Apple silicon.
if [ "$os" = darwin ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
  arch=arm64
fi
[ "$os-$arch" = darwin-x64 ] && fail "no binary for Intel Macs; install with npm or pixi instead"
# The binary embeds Node's glibc build.
if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then
  fail "no binary for musl libc; install with npm or pixi instead"
fi

if [ -n "${DIFFLE_DOWNLOAD_URL:-}" ]; then
  base=$DIFFLE_DOWNLOAD_URL
elif [ "$version" = latest ]; then
  base=https://github.com/$repo/releases/latest/download
else
  base=https://github.com/$repo/releases/download/$version
fi
asset=diffle-$os-$arch.tar.gz

if command -v curl > /dev/null; then
  fetch() { curl -fsSL -o "$2" "$1"; }
elif command -v wget > /dev/null; then
  fetch() { wget -qO "$2" "$1"; }
else
  fail "needs curl or wget"
fi

if command -v sha256sum > /dev/null; then
  sha256() { sha256sum "$1"; }
elif command -v shasum > /dev/null; then
  sha256() { shasum -a 256 "$1"; }
else
  fail "needs sha256sum or shasum"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "downloading $base/$asset" >&2
fetch "$base/$asset" "$tmp/$asset" || fail "download failed: $base/$asset"
fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || fail "download failed: $base/SHA256SUMS"

expected=$(awk -v f="$asset" '$2 == f { print $1 }' "$tmp/SHA256SUMS")
[ -n "$expected" ] || fail "SHA256SUMS lists no $asset"
actual=$(sha256 "$tmp/$asset" | awk '{ print $1 }')
[ "$expected" = "$actual" ] || fail "checksum mismatch for $asset"

tar -xzf "$tmp/$asset" -C "$tmp" diffle
mkdir -p "$dir"
# Replace rather than overwrite, so a running diffle keeps its inode and macOS its signature cache.
mv -f "$tmp/diffle" "$dir/diffle"
chmod 755 "$dir/diffle"

echo "installed $("$dir/diffle" --version) to $dir/diffle" >&2
case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "add $dir to your PATH to run diffle" >&2 ;;
esac
