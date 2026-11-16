#!/usr/bin/env bash
set -euo pipefail
source "$HOME/.cargo/env"; export PATH="$PATH:$HOME/.sp1/bin"
rm -rf ~/sp1tmpl && mkdir -p ~/sp1tmpl && cd ~/sp1tmpl
cargo prove new --help | head -30
cargo prove new --bare tmpl >/dev/null 2>&1 || cargo prove new tmpl
cd tmpl && find . -name Cargo.toml -not -path './target/*' | while read f; do echo "=== $f"; cat "$f"; done
echo "=== program main"; cat program/src/main.rs
echo "=== script main"; ls script/src/bin; cat script/src/bin/main.rs | head -120
cat script/build.rs 2>/dev/null; cat rust-toolchain* 2>/dev/null
