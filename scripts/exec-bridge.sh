#!/usr/bin/env bash
# Execute (no proof) segment + deposit for a deposit fixture. Usage: exec-bridge.sh <fixture.json>
set -euo pipefail
F=$1
S=/mnt/e/CKB/spike-eaglesong-sp1/scripts/sp1.sh
export RUST_LOG=warn
bash $S --execute --net testnet --segment "$F" 2>&1 | grep -vE "^\s+(Compiling|Downloaded|Downloading)" | grep -E "kind=|deposit:|match|total cycles|cycles/header|panicked|error" | head
bash $S --execute --deposit "$F" 2>&1 | grep -vE "^\s+(Compiling|Downloaded|Downloading)" | grep -E "kind=|deposit:|match|total cycles|cycles/header|panicked|error" | head
