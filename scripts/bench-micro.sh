#!/usr/bin/env bash
# Differential per-component cycle costs. Writes results/micro.txt
set -euo pipefail
source "$HOME/.cargo/env"; export PATH="$PATH:$HOME/.sp1/bin"; export CARGO_TARGET_DIR="$HOME/spike-target"
cd /mnt/e/CKB/spike-eaglesong-sp1/script
cargo build --release -q 2>&1 | grep -E "^error" || true
B=$CARGO_TARGET_DIR/release/ckb-pow-script; N=256
declare -A C
for m in 10 11 12 13 14 15; do
  C[$m]=$(RUST_LOG=warn $B --execute --n $N --micro $m 2>&1 | sed -n 's/.*total cycles: \([0-9]*\).*/\1/p')
done
out=../results/micro.txt
{
  echo "n=$N mainnet headers; cycles per header = (mode - baseline)/n"
  for m in 11 12 13 14 15; do
    name=$(case $m in 11) echo "pow_hash  blake2b(192B)";; 12) echo "eaglesong reference sponge";; 13) echo "eaglesong_pow48 fast path";; 14) echo "block_hash blake2b(208B)";; 15) echo "compact_to_target+difficulty";; esac)
    echo "$name: $(( (C[$m]-C[10]) / N ))"
  done
  echo "baseline total=${C[10]}"
} | tee "$out"
