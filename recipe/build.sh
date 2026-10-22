#!/usr/bin/env bash
set -euxo pipefail

# The Rust binary embeds the web client from dist/client
npm ci --ignore-scripts
npm run build

export CARGO_PROFILE_RELEASE_STRIP=symbols
cargo install --locked --no-track --bins --root "${PREFIX}" --path crates/diffle

# Pixi: prevent CONDA_PREFIX from leaking into sandboxed processes
mkdir -p "${PREFIX}/etc/pixi/diffle"
touch "${PREFIX}/etc/pixi/diffle/global-ignore-conda-prefix"

mkdir -p "${PREFIX}/share/zsh/site-functions" "${PREFIX}/share/bash-completion/completions" "${PREFIX}/share/fish/vendor_completions.d"
"${PREFIX}/bin/diffle" completion --shell zsh > "${PREFIX}/share/zsh/site-functions/_diffle"
"${PREFIX}/bin/diffle" completion --shell bash > "${PREFIX}/share/bash-completion/completions/diffle"
"${PREFIX}/bin/diffle" completion --shell fish > "${PREFIX}/share/fish/vendor_completions.d/diffle.fish"
