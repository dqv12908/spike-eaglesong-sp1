#!/usr/bin/env bash
set -euo pipefail
sh /mnt/e/CKB/spike-eaglesong-sp1/.downloads/installers/agave-install.sh >/dev/null 2>&1
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
solana --version
cargo-build-sbf --version || true
# pre-fetch SBF platform tools by building a trivial program
source "$HOME/.cargo/env"
rm -rf /tmp/sbfprobe && cargo new --lib -q /tmp/sbfprobe && cd /tmp/sbfprobe
printf '[lib]\ncrate-type=["cdylib","lib"]\n' >> Cargo.toml
cargo-build-sbf 2>&1 | tail -5
cargo-build-sbf --version
