#!/usr/bin/env bash
# Cycle-count sweep (execute only). Writes results/exec-sweep.txt
set -uo pipefail
B=/root/spike-target/release/ckb-pow-script
cd /mnt/e/CKB/spike-eaglesong-sp1/script
mkdir -p ../results; out=../results/exec-sweep.txt; : > "$out"
for n in 1 4 16 64 256; do
  echo "### mainnet n=$n" | tee -a "$out"
  RUST_LOG=warn $B --execute --n $n 2>&1 | grep -E "summary matches|total cycles|cycles/header|wall time|gas:" | tee -a "$out"
done
echo "### testnet (EaglesongBlake2b) n=16" | tee -a "$out"
RUST_LOG=warn $B --execute --net testnet --n 16 2>&1 | grep -E "summary matches|total cycles|cycles/header|gas:" | tee -a "$out"
echo "### breakdown mainnet n=16 (cycle-tracker; totals inflated by extra work)" | tee -a "$out"
RUST_LOG=info $B --execute --breakdown --n 16 2>&1 | grep -iE "cycle|tracker|pow_hash|eaglesong|block_hash|verify_segment" | grep -v "^cycles/header\|^total cycles" | tee -a "$out"
