#!/usr/bin/env bash
# Deploy a program. Usage: deploy.sh <rpc-url> <payer-keypair.json> [name]  (name: ckb_bridge | ckb_light_client)
set -euo pipefail
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
RPC=$1; PAYER=$2; N=${3:-ckb_bridge}; D=/mnt/e/CKB/spike-eaglesong-sp1/solana/deploy
[[ -f $D/$N-keypair.json ]] || solana-keygen new --no-bip39-passphrase --silent -o $D/$N-keypair.json
for i in $(seq 1 30); do solana -u "$RPC" cluster-version >/dev/null 2>&1 && break; sleep 2; done
echo "cluster: $(solana -u "$RPC" cluster-version)"
echo "payer:   $(solana-keygen pubkey "$PAYER")  balance: $(solana -u "$RPC" balance -k "$PAYER")"
solana -u "$RPC" program deploy -k "$PAYER" --program-id "$D/$N-keypair.json" "$D/$N.so" --output json
solana -u "$RPC" -k "$PAYER" program show "$(solana-keygen pubkey "$D/$N-keypair.json")"
echo "payer balance after: $(solana -u "$RPC" balance -k "$PAYER")"
