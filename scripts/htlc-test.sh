#!/usr/bin/env bash
# Host tests + SBF build of the Solana HTLC escrow (solana/htlc). Usage: htlc-test.sh [test|build|all]
set -euo pipefail
source "$HOME/.cargo/env"; export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
export CARGO_TARGET_DIR="$HOME/solana-htlc-target"
cd /mnt/e/CKB/spike-eaglesong-sp1/solana/htlc
what=${1:-all}
if [[ $what == test || $what == all ]]; then cargo test --release 2>&1 | grep -E "^test |test result|error|warning|panicked|-->" ; fi
if [[ $what == build || $what == all ]]; then
  cargo-build-sbf --sbf-out-dir "$HOME/solana-htlc-out" 2>&1 | grep -vE "^\s+Compiling" | tail -8
  cp "$HOME/solana-htlc-out/sol_htlc.so" /mnt/e/CKB/spike-eaglesong-sp1/solana/deploy/sol_htlc.so
  ls -la /mnt/e/CKB/spike-eaglesong-sp1/solana/deploy/sol_htlc.so
fi
