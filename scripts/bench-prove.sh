#!/usr/bin/env bash
# Timed proving runs. Usage: bench-prove.sh <system> <n> ; appends to results/prove.txt
set -uo pipefail
source "$HOME/.cargo/env"; export PATH="$PATH:$HOME/.sp1/bin"; export CARGO_TARGET_DIR="$HOME/spike-target"
cd /mnt/e/CKB/spike-eaglesong-sp1/script
B=$CARGO_TARGET_DIR/release/ckb-pow-script
sys=$1; n=$2; log=../results/prove-$sys-n$n.log
echo "### system=$sys n=$n $(date -u +%FT%TZ)" > "$log"
/usr/bin/time -v $B --prove --system $sys --n $n >> "$log" 2>&1
echo "exit=$?" >> "$log"
grep -E "setup:|system=|proof bytes|Maximum resident|Elapsed \(wall|exit=|panicked|Error" "$log" | tee -a ../results/prove.txt
