#!/usr/bin/env bash
# Groth16-prove the light-client segment and the deposit for a fixture.
# Usage: prove-bridge.sh <fixture.json> [name-prefix=bridge]  -> fixtures/proofs/<prefix>-{segment,deposit}.json
set -uo pipefail
F=$1; P=${2:-bridge}; S=/mnt/e/CKB/spike-eaglesong-sp1/scripts/sp1.sh; L=/mnt/e/CKB/spike-eaglesong-sp1/results
export RUST_LOG=info
/usr/bin/time -v bash $S --prove --system groth16 --net testnet --segment "$F" --name $P-segment > $L/prove-$P-segment.log 2>&1
echo "segment exit=$?"
/usr/bin/time -v bash $S --prove --system groth16 --deposit "$F" --name $P-deposit > $L/prove-$P-deposit.log 2>&1
echo "deposit exit=$?"
grep -hE "program vkey|kind=.*prove=|proof bytes|Maximum resident|panicked" $L/prove-$P-*.log
