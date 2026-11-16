#!/usr/bin/env bash
# Run the SP1 host inside WSL. Source stays on E:, build artifacts go to the Linux FS (fast).
# Usage: scripts/sp1.sh <host args...>     e.g. scripts/sp1.sh --execute --n 16
set -euo pipefail
source "$HOME/.cargo/env"
export PATH="$PATH:$HOME/.sp1/bin"
export CARGO_TARGET_DIR="$HOME/spike-target"
export RUST_LOG="${RUST_LOG:-info}"
cd /mnt/e/CKB/spike-eaglesong-sp1/script
cargo run --release -- "$@"
