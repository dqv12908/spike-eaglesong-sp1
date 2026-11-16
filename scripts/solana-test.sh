#!/usr/bin/env bash
# Host tests of the Solana verifier + SBF build. Usage: solana-test.sh [test|build|all]
set -euo pipefail
source "$HOME/.cargo/env"; export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
export CARGO_TARGET_DIR="$HOME/solana-target"
cd /mnt/e/CKB/spike-eaglesong-sp1/solana/program
what=${1:-all}
if [[ $what == test || $what == all ]]; then cargo test --release 2>&1 | grep -E "^test |test result|error|warning: unused|panicked|-->" ; fi
if [[ $what == build || $what == all ]]; then
  # v1 (header-only, 8XjZL4HW...) = ckb_light_client.so; v2 (deposit->mint, 5YCcYWzv...) = ckb_bridge.so;
  # current build (light client v3 + burn) = ckb_bridge_v3.so
  cargo-build-sbf --sbf-out-dir "$HOME/solana-sbf-out" 2>&1 | grep -vE "^\s+Compiling" | tail -15
  cp "$HOME/solana-sbf-out/ckb_light_client.so" /mnt/e/CKB/spike-eaglesong-sp1/solana/deploy/ckb_bridge_v3.so
  ls -la /mnt/e/CKB/spike-eaglesong-sp1/solana/deploy
fi
