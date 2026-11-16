#!/usr/bin/env bash
set -uo pipefail
source "$HOME/.cargo/env"; export PATH="$PATH:$HOME/.sp1/bin:/usr/lib/go/bin"; export CARGO_TARGET_DIR="$HOME/spike-target"
cd /mnt/e/CKB/spike-eaglesong-sp1/script
log=../results/build-native-gnark.log
cargo build --release > "$log" 2>&1; echo "build exit=$?" | tee -a "$log"
grep -E "^error" "$log" | head
bash /mnt/e/CKB/spike-eaglesong-sp1/scripts/bench-prove.sh groth16 16
